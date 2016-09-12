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

import {
    mapYcmCompletionsToLanguageServerCompletions,
    mapYcmDiagnosticToLanguageServerDiagnostic,
    crossPlatformBufferToString,
    logger,
    crossPlatformUri,
    mapYcmTypeToHover,
    mapYcmLocationToLocation
} from './utils'

import {
	IPCMessageReader, IPCMessageWriter,
	createConnection, IConnection, TextDocumentSyncKind,
	TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
	InitializeParams, InitializeResult, TextDocumentPositionParams,
	CompletionItem, CompletionItemKind, Position, Location
} from 'vscode-languageserver'

export default class Ycm{
    private port: number
    private hmacSecret: Buffer
    private process: childProcess.ChildProcess
    private workingDir: string

    private settings: Settings
    private ready = false

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
        options.extra_conf_globlist = []
        options.rustSrcPath = ''
        const optionsFile = path.resolve(os.tmpdir(), `VSCodeYcmOptions-${Date.now()}`)
        logger(`processData: ${JSON.stringify(options)}`)
        return new Promise<string>((resolve, reject) => {
            fs.writeFile(optionsFile, JSON.stringify(options), {encoding: 'utf8'}, (err) => {
                if (err) reject(err)
                else resolve(optionsFile)
            })
        })
    }

    private _start(optionsFile): Promise<childProcess.ChildProcess> {
        return new Promise<childProcess.ChildProcess>((resolve, reject) => {
            let cmd = this.settings.ycmd.python
            let args = [
                path.resolve(this.settings.ycmd.path, 'ycmd'),
                `--port=${this.port}`,
                `--options_file=${optionsFile}`,
                `--idle_suicide_seconds=600`
            ]
            if (process.platform === 'win32') {
                args = args.map(it => `"${it.replace(/"/g, '\\"')}"`)
                cmd = `"${cmd.replace(/"/g, '\\"')}"`
                args.unshift(cmd)
                args = ['/s', '/d', '/c', `"${args.join(' ')}"`]
                cmd = 'cmd.exe'
            }

            const options = {
                windowsVerbatimArguments: true,
                cwd: this.workingDir,
                env: process.env
            }
            logger('_start', args)
            const cp = childProcess.spawn(cmd, args, options)
            logger('_start', `process spawn success ${cp.pid}`)
            cp.stdout.on('data', (data: Buffer) => logger(`ycm stdout`,crossPlatformBufferToString(data)))
            cp.stderr.on('data', (data: Buffer) => logger(`ycm stderr`, crossPlatformBufferToString(data)))
            cp.on('error', (err) => {
                logger('_start error', err)
            })
            cp.on('exit', (code) => {
                logger('_start exit', code)
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

    private static async start(workingDir: string, settings: Settings): Promise<Ycm> {
        try {
            const ycm = new Ycm(settings)
            ycm.workingDir = workingDir
            const data = await Promise.all<any>([ycm.findUnusedPort(), ycm.generateRandomSecret(), ycm.readDefaultOptions()]) as [number, Buffer, any]
            logger('start',`data: ${data}`)
            const optionsFile = await ycm.processData(data)
            logger('start', `optionsFile: ${optionsFile}`)
            ycm.process = await ycm._start(optionsFile)
            logger('start', `ycm started: ${ycm.process.pid}`)
            return ycm
        } catch(err) {
            logger('start error', err)
            return null
        }
    }

    private static Instance: Ycm
    private static Initializing = false
    public static async getInstance(workingDir: string, settings: Settings): Promise<Ycm> {
        if (Ycm.Initializing) return new Promise<Ycm>((resolve, reject) => {
            setTimeout(() => resolve(Ycm.getInstance(workingDir, settings)), 50)
        })
        if (!Ycm.Instance || Ycm.Instance.workingDir !== workingDir || !_.isEqual(Ycm.Instance.settings, settings) || !Ycm.Instance.process) {
            logger('getInstance', `ycm is restarting`)
            if (!!Ycm.Instance) Ycm.Instance.reset()
            try {
                Ycm.Initializing = true
                Ycm.Instance = await Ycm.start(workingDir, settings)
            } catch (err) {
                logger('getInstance error', err)
            }
            Ycm.Initializing = false
        }
        return Ycm.Instance
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
            wmic.on('error', (err) => logger('killOnWindows error', err))
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
        const hmac2 = await this.generateHmac(data, 'base64')
        if (!_.isString(hmac) || !_.isString(hmac2)) return false
        return hmac === hmac2
    }

    private signMessage(message: rp.RequestPromiseOptions, path: string, payload: string) {
        const hmac = this.generateHmac(Buffer.concat([
            this.generateHmac(message.method),
            this.generateHmac(path),
            this.generateHmac(payload)]), 'base64')
        message.headers['X-Ycm-Hmac'] = hmac
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
            resolveWithFullResponse: true
            // timeout: 5000
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
        const response = await rp(`http://localhost:${this.port}${path}`, message)
        if (!this.verifyHmac(response.body, response.headers['x-ycm-hmac'])) throw new Error('Hmac check failed')
        return JSON.parse(response.body)
    }

    private buildRequest(document: TextDocument, position: Position, documents: TextDocuments): RequestType
    private buildRequest(document: TextDocument, position: Position, documents: TextDocuments, event: string): RequestEventType
    private buildRequest(document: TextDocument, position: Position = null, documents: TextDocuments = null, event: string = null) {
        const url = crossPlatformUri(document.uri)
        // const url = document.uri
        logger(`buildRequest`, `document, ${url}; position: ${position}; event: ${event}`)
        const params: RequestType = {
            filepath: url,
            working_dir: this.workingDir,
            file_data: { }
        }
        documents.all().forEach(it => {
            const url = crossPlatformUri(it.uri)
            params.file_data[url] = {
                contents: document.getText(),
                filetypes: [document.languageId]
            }
        })
        
        if (position != null) {
            params.line_num = position.line + 1
            params.column_num = position.character + 1
        } else {
            params.line_num = 1
            params.column_num = 1
        }

        if (event != null) {
            return _.assign(params, {
                event_name: event
            })
        }
        return params
    }

    private buildCommandRequest(document: TextDocument, position: Position, documents: TextDocuments, command: string): RequestCommandType {
        const params = this.buildRequest(document, position, documents) as RequestCommandType
        params.command_arguments = [command]
        return params
    }

    public async getReady(document: TextDocument, documents: TextDocuments) {
        const params = this.buildRequest(document, null, documents, 'BufferVisit')
        const response = await this.request('POST', 'event_notification', params)
        logger(`getReady`, JSON.stringify(response))
        this.ready = true
    }

    public async completion(document: TextDocument, position: Position, documents: TextDocuments): Promise<CompletionItem[]> {
        const params = this.buildRequest(document, position, documents)
        const response = await this.request('POST', 'completions', params)
        logger(`completion`, JSON.stringify(response))
        const completions = response['completions'] as YcmCompletionItem[]
        const res = mapYcmCompletionsToLanguageServerCompletions(completions)
        logger(`completion`, `ycm responsed ${res.length} items`) 
        return res
    }

    private requestEvent(document: TextDocument, documents: TextDocuments, event: string) {
        const params = this.buildRequest(document, null, documents, event)
        return this.request('POST', 'event_notification', params)
    }

    private async runCompleterCommand(document: TextDocument, position: Position, documents: TextDocuments, command: string) {
        const params = this.buildCommandRequest(document, position, documents, command)
        const response = await this.request('POST', 'run_completer_command', params)
        return response
    }

    public async getType(document: TextDocument, position: Position, documents: TextDocuments) {
        const type = await this.runCompleterCommand(document, position, documents, 'GetType') as YcmGetTypeResponse
        logger('getType', JSON.stringify(type))
        return mapYcmTypeToHover(type, document.languageId)
    }

    public async goToDefinition(document: TextDocument, position: Position, documents: TextDocuments) {
        const definition = await this.runCompleterCommand(document, position, documents, 'GoToDefinition')
        logger('goToDefinition', JSON.stringify(definition))
        return mapYcmLocationToLocation(definition as YcmLocation)
    }

    public async readyToParse(document: TextDocument, documents: TextDocuments): Promise<Diagnostic[]> {
        try {
            const response = await this.requestEvent(document, documents, 'FileReadyToParse')
            if (!_.isArray(response)) return []
            logger(`readyToParse` ,`ycm responsed ${response.length} items`)
            const issues = response as YcmDiagnosticItem[]
            const uri = crossPlatformUri(document.uri)
            return mapYcmDiagnosticToLanguageServerDiagnostic(issues.filter(it => it.location.filepath === uri))
                .filter(it => !!it.range)
        } catch (err) {
            return []
        }
    }

    public async currentIdentifierFinished(document: TextDocument, documents: TextDocuments) {
        await this.requestEvent(document, documents, 'CurrentIdentifierFinished')
    }

    public async insertLeave(document: TextDocument, documents: TextDocuments) {
        await this.requestEvent(document, documents, 'InsertLeave')
    }
}

type RequestType = {
    filepath: string,
    working_dir: string,
    line_num?: number,
    column_num?: number,
    force_semantic?: boolean
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

type RequestCommandType = RequestType & {
    command_arguments: string[]
}

export type YcmCompletionItem = {
    menu_text: string
    insertion_text: string
    detailed_info: string
    extra_menu_info: string
    kind: string
}

export type YcmLocation = {
    filepath: string,
    column_num: number,
    line_num: number
}

export type YcmRange = {
    start: YcmLocation
    end: YcmLocation
}

export type YcmDiagnosticItem = {
    kind: "ERROR" | "WARNING"
    text: string
    ranges: YcmRange[]
    location: YcmLocation
    location_extent: YcmRange
    fixit_available: boolean
}

export type YcmGetTypeResponse = {
    message: string
}

export interface Settings {
	ycmd: {
        path: string
        global_extra_config: string,
        python: string
    }
}
