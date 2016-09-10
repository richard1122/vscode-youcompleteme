import * as net from 'net'
import * as crypto from 'crypto'
import * as childProcess from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as _ from 'lodash'
import * as http from 'http'
import * as url from 'url'
import * as qs from 'querystring'
import * as rp from 'request-promise'
import {mapYcmCompletionsToLanguageServerCompletions} from './utils'

import {
	IPCMessageReader, IPCMessageWriter,
	createConnection, IConnection, TextDocumentSyncKind,
	TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
	InitializeParams, InitializeResult, TextDocumentPositionParams,
	CompletionItem, CompletionItemKind, Position
} from 'vscode-languageserver'

export default class Ycm{
    private port: number
    private hmacSecret: Buffer
    private process: childProcess.ChildProcess
    private workingDir: string

    private settings: Settings

    private constructor(settings: Settings) {
        this.settings = settings
    }

    private findUnusedPort(): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            const server = net.createServer()
            server.listen(0, () => {
                resolve(server.address().port)
                server.close()
            })
            server.on('error', (err) => reject(err))
        })
    }

    private readDefaultOptions() {
        return new Promise<any>((resolve, reject) => {
            fs.readFile(path.resolve(this.settings.ycmd.path, 'ycmd', 'default_settings.json'), {encoding: 'utf8'}, (err, data) => {
                if (err) reject(err)
                else resolve(JSON.parse(data))
            })
        })
    }

    private generateRandomSecret(): Buffer {
        return crypto.randomBytes(16)
    }

    private processData([unusedPort, hmac, options]: [number, Buffer, any]): Promise<string> {
        this.port = unusedPort
        this.hmacSecret = hmac
        options.hmac_secret = this.hmacSecret.toString('base64')
        options.global_ycm_extra_conf = this.settings.ycmd.global_extra_config
        options.confirm_extra_conf = true
        const optionsFile = path.resolve(os.tmpdir(), `VSCodeYcmOptions-${crypto.randomBytes(8).toString('hex')}`)
        console.log(`processData: ${JSON.stringify(options)}`)
        return new Promise<string>((resolve, reject) => {
            fs.writeFile(optionsFile, JSON.stringify(options), {encoding: 'utf8'}, (err) => {
                if (err) reject(err)
                else resolve(optionsFile)
            })
        })
    }

    private _start(optionsFile): Promise<childProcess.ChildProcess> {
        return new Promise<childProcess.ChildProcess>((resolve, reject) => {
            let cmd = 'python'
            const args = [
                path.resolve(this.settings.ycmd.path, 'ycmd'),
                `--port=${this.port}`,
                `--options_file=${optionsFile}`,
                `--idle_suicide_seconds=600`
            ]
            if (process.platform === 'win32') {
                args.unshift('/s', '/c', `${cmd}`)
                cmd = 'cmd.exe'
            }

            const cp = childProcess.spawn(cmd, args, {
                cwd: this.workingDir,
                env: process.env
            })
            console.log(`process spawn success ${cp.pid}`)
            cp.stdout.on('data', (data) => console.log(data.toString()))
            cp.stderr.on('data', (data) => console.error(data.toString()))
            cp.on('error', (err) => {
                console.error(err)
            })
            cp.on('exit', (code) => {
                console.warn(`process closed: ${code}`)
                this.process = null
                switch (code) {
                    case 3: reject(new Error('Unexpected error while loading the YCM core library.'))
                    case 4: reject(new Error('YCM core library not detected; you need to compile YCM before using it. Follow the instructions in the documentation.'))
                    case 5: reject(new Error('YCM core library compiled for Python 3 but loaded in Python 2. Set the Python Executable config to a Python 3 interpreter path.'))
                    case 6: reject(new Error('YCM core library compiled for Python 2 but loaded in Python 3. Set the Python Executable config to a Python 2 interpreter path.'))
                    case 7: reject(new Error('YCM core library too old; PLEASE RECOMPILE by running the install.py script. See the documentation for more details.'))
                }
            })
            setTimeout(() => resolve(cp), 1000)
        })
    }

    public static async start(workingDir: string, settings: Settings): Promise<Ycm> {
        try {
            const ycm = new Ycm(settings)
            ycm.workingDir = workingDir
            const data = await Promise.all<any>([ycm.findUnusedPort(), ycm.generateRandomSecret(), ycm.readDefaultOptions()]) as [number, Buffer, any]
            console.log(`data: ${data}`)
            const optionsFile = await ycm.processData(data)
            console.log(`optionsFile: ${optionsFile}`)
            ycm.process = await ycm._start(optionsFile)
            console.log(`ycm started: ${ycm.process.pid}`)
            return ycm
        } catch(err) {
            console.error(err)
            return null
        }
    }

    public async reset() {
        if (this.process != null) {
            if (process.platform === 'win32') await this.killOnWindows()
            //TODO: kill cmd.exe may not kill python
            this.process.kill()
            this.port = null
            this.hmacSecret = null
        }
    }

    private killOnWindows() {
        return new Promise((resolve, reject) => {
            const parentPid = this.process.pid
            const wmic = childProcess.spawn('wmic', [
                'process', 'where', `(ParentProcessId=${parentPid})`, 'get', 'processid'
            ])
            wmic.on('error', (err) => console.error(err))
            let output = ''
            wmic.stdout.on('data', (data: string) => output += data)
            wmic.stdout.on('close', () => {
                output.split(/\s+/)
                    .filter(pid => /^\d+$/.test(pid))
                    .map(pid => parseInt(pid))
                    .filter(pid => pid != parentPid && pid > 0 && pid < Infinity)
                    .map(pid => process.kill(pid))
                resolve()
            })
        })
    }

    private generateHmac(data: string | Buffer): Buffer
    private generateHmac(data: string | Buffer, encoding: string): string
    private generateHmac(data: string | Buffer, encoding: string = null): Buffer | string{
        return crypto.createHmac('sha256', this.hmacSecret).update(data).digest(encoding)
    }

    private async verifyHmac(data: string, hmac: string) {
        const hmac2 = await this.generateHmac(data)
        if (!_.isString(hmac) || !_.isString(hmac2)) return false
        return hmac === hmac2
    }

    private signMessage(message: rp.RequestPromiseOptions, path: string, payload: string) {
        const hmac = this.generateHmac(Buffer.concat([
            this.generateHmac(message.method),
            this.generateHmac(path),
            this.generateHmac(payload)]), 'base64')
        message.headers['X-Ycm-Hmac'] = hmac
        console.log(`signMessage ${hmac}, ${[message.method, path, payload].join('')}`) 
    }

    private escapeUnicode(string: string) {
        const result: string[] = []
        for (const i of _.range(string.length)) {
            const char = string.charAt(i)
            const charCode = string.charCodeAt(i)
            if (charCode < 0x80) result.push(char)
            else result.push(('\\u' + ('0000' + charCode.toString(16)).substr(-4)))
        }
        return result.join('')
    }

    private async request(method: "POST" | "GET", endpoint: string, params: RequestType = null) {
        const message: rp.RequestPromiseOptions = {
            port: this.port,
            method: method,
            headers: {},
            gzip: false,
            timeout: 3000
        }
        const path = url.resolve('/', endpoint)
        if (method === 'GET') message.qs = params
        else {
            const payload = this.escapeUnicode(JSON.stringify(params))
            this.signMessage(message, path, payload)
            message.headers['Content-Type'] = 'application/json'
            message.headers['Content-Length'] = payload.length
            message.body = payload
        }
        console.log(`request: ${JSON.stringify(message)}`)
        const response = await rp(`http://localhost:${this.port}${path}`, message)
        return JSON.parse(response)
    }

    private buildRequest(document: TextDocument): RequestType
    private buildRequest(document: TextDocument, position: Position): RequestType
    private buildRequest(document: TextDocument, position: Position, event: string): RequestEventType
    private buildRequest(document: TextDocument, position: Position = null, event: string = null) {
        console.log(`buildRequest: document, ${document}; position: ${position}`)
        const params: RequestType = {
            filepath: document.uri,
            working_dir: this.workingDir,
            force_semantic: true,
            file_data: {
            }
        }
        params.file_data[document.uri] = {
            contents: document.getText(),
            filetypes: [document.languageId]
        }
        if (position != null) {
            params.line_num = position.line + 1,
            params.column_num = position.character + 1
        }

        if (event != null) {
            return _.assign(params, {
                event_name: event
            })
        }
        return params
    }

    public async completion(document: TextDocument, position: Position): Promise<CompletionItem[]> {
        const params = this.buildRequest(document, position)
        const response = await this.request('POST', 'completions', params)
        const completions = response['completions'] as YcmCompletionItem[]
        const res = mapYcmCompletionsToLanguageServerCompletions(completions)
        console.log(`completion: ycm responsed ${res.length} items`) 
        return res
    }

    public async readyToParse(document: TextDocument) {
        const params = this.buildRequest(document, null, 'FileReadyToParse')
        const response = await this.request('POST', 'event_notification', params)
    }
}

type RequestType = {
    filepath: string,
    working_dir: string,
    line_num?: number,
    column_num?: number,
    force_semantic: boolean
    file_data: {
        [key: string]: {
            contents: string,
            filetypes: string[]
        }
    }
}

type RequestEventType = RequestType & {
    event_name: string
}

export type YcmCompletionItem = {
    menu_text: string
    insertion_text: string
    detailed_info: string
    extra_menu_info: string
    kind: string
}

export interface Settings {
	ycmd: {
        path: string,
        global_extra_config: string
    }
}