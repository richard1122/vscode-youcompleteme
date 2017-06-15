import * as net from 'net'
import * as crypto from 'crypto'
import * as childProcess from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as _ from 'lodash'
import * as url from 'url'
import * as qs from 'querystring'

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
    CompletionItem, CompletionItemKind, Position, Location, RemoteWindow,
    MessageActionItem
} from 'vscode-languageserver'

import YcmRequest from './ycmRequest'

export default class Ycm {
    private port: number
    private hmacSecret: Buffer
    private process: childProcess.ChildProcess
    private workingDir: string
    private window: RemoteWindow

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
        options.confirm_extra_conf = this.settings.ycmd.confirm_extra_conf
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
            cp.stdout.on('data', (data: Buffer) => logger(`ycm stdout`, crossPlatformBufferToString(data)))
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

    private static async start(workingDir: string, settings: Settings, window: RemoteWindow): Promise<Ycm> {
        try {
            const ycm = new Ycm(settings)
            ycm.workingDir = workingDir
            ycm.window = window
            const data = await Promise.all<any>([ycm.findUnusedPort(), ycm.generateRandomSecret(), ycm.readDefaultOptions()]) as [number, Buffer, any]
            logger('start', `unused port: ${data[0]}`)
            logger('start', `random secret: ${data[1].toString('hex')}`)
            logger('start', `default options: ${JSON.stringify(data[2])}`)
            const optionsFile = await ycm.processData(data)
            logger('start', `optionsFile: ${optionsFile}`)
            ycm.process = await ycm._start(optionsFile)
            logger('start', `ycm started: ${ycm.process.pid}`)
            return ycm
        } catch (err) {
            throw err
        }
    }

    private static Instance: Ycm
    private static Initializing = false
    public static async getInstance(workingDir: string, settings: Settings, window: RemoteWindow): Promise<Ycm> {
        if (Ycm.Initializing) return new Promise<Ycm>((resolve, reject) => {
            logger('getInstance', 'ycm is initializing, delay 200ms...')
            setTimeout(() => resolve(Ycm.getInstance(workingDir, settings, window)), 200)
        })
        if (!Ycm.Instance || Ycm.Instance.workingDir !== workingDir || !_.isEqual(Ycm.Instance.settings, settings) || !Ycm.Instance.process) {
            logger('getInstance', `ycm is restarting`)
            if (!!Ycm.Instance) await Ycm.Instance.reset()
            try {
                Ycm.Initializing = true
                Ycm.Instance = await Ycm.start(workingDir, settings, window)
            } catch (err) {
                throw err
            } finally {
                Ycm.Initializing = false
            }
        }
        return Ycm.Instance
    }

    public static reset() {
        if (!!Ycm.Instance) {
            Ycm.Instance.reset()
        }
    }

    public async reset() {
        if (!!this.process) {
            try {
                const request = this.buildRequest(null)
                await request.request('shutdown')
            } catch (e) {
                logger('reset', e)
            }
            this.process = null
            this.port = null
            this.hmacSecret = null
        }
    }

    private buildRequest(currentDocument: string, position: Position = null, documents: TextDocuments = null, event: string = null) {
        return new YcmRequest(this.window, this.port, this.hmacSecret, this.workingDir, currentDocument, position, documents, event)
    }

    private runCompleterCommand(documentUri: string, position: Position, documents: TextDocuments, command: string) {
        return this.buildRequest(documentUri, position, documents, command).isCommand().request()
    }

    private eventNotification(documentUri: string, position: Position, documents: TextDocuments, event: string) {
        return this.buildRequest(documentUri, position, documents, event).request()
    }

    public async getReady(documentUri: string, documents: TextDocuments) {
        const response = await this.eventNotification(documentUri, null, documents, 'BufferVisit')
        logger(`getReady`, JSON.stringify(response))
    }

    public async completion(documentUri: string, position: Position, documents: TextDocuments): Promise<CompletionItem[]> {
        const request = this.buildRequest(documentUri, position, documents)
        const response = await request.request('completions')
        const completions = response['completions'] as YcmCompletionItem[]
        const res = mapYcmCompletionsToLanguageServerCompletions(completions)
        logger(`completion`, `ycm responsed ${res.length} items`)
        return res
    }

    public async getType(documentUri: string, position: Position, documents: TextDocuments, imprecise: boolean = false) {
        const type = await this.runCompleterCommand(documentUri, position, documents, imprecise ? 'GetTypeImprecise' : 'GetType') as YcmGetTypeResponse
        logger('getType', JSON.stringify(type))
        return mapYcmTypeToHover(type, documents.get(documentUri).languageId)
    }

    public async goTo(documentUri: string, position: Position, documents: TextDocuments) {
        const definition = await this.runCompleterCommand(documentUri, position, documents, 'GoTo')
        logger('goTo', JSON.stringify(definition))
        return mapYcmLocationToLocation(definition as YcmLocation)
    }

    public async getDoc(documentUri: string, position: Position, documents: TextDocuments) {
        const doc = await this.runCompleterCommand(documentUri, position, documents, 'GetDoc')
        logger('getDoc', JSON.stringify(doc))
    }

    public async getDetailedDiagnostic(documentUri: string, position: Position, documents: TextDocuments) {
        const request = this.buildRequest(documentUri, position, documents)
        const response = await request.request('detailed_diagnostic')
    }

    public async readyToParse(documentUri: string, documents: TextDocuments): Promise<Diagnostic[]> {
        try {
            const response = await this.eventNotification(documentUri, null, documents, 'FileReadyToParse')
            if (!_.isArray(response)) return []
            logger(`readyToParse`, `ycm responsed ${response.length} items`)
            const issues = response as YcmDiagnosticItem[]
            const uri = crossPlatformUri(documentUri)

            const [reported_issues, header_issues] = _.partition(issues, it => it.location.filepath === uri)

            // If there are issues we come across in files other than the
            // one we're looking at, it's probably from an included header.
            // Since they may be the root source of errors in the file
            // we're looking at, instead of filtering them all out, let's
            // just pick the first one to display and hard-code it to
            // show up on the first line, since the language
            // server diagnostic interface doesn't appear to be able to
            // report errors in different files.
            if (header_issues.length > 0) {
                const issue = header_issues[0]
                const relative = path.relative(path.parse(uri).dir, path.parse(issue.location.filepath).dir)
                let location = issue.location.filepath
                if (relative.split(/[\/\\\\]/).length <= 1) {
                    location = path.normalize(`./${relative}/${path.parse(issue.location.filepath).base}`)
                }

                reported_issues.unshift({
                    ...issue,
                    text: `${issue.text} in included file ${location}:${issue.location.line_num}`,
                    location: {
                        ...issue.location,
                        column_num: 1,
                        line_num: 1,
                    },
                    location_extent: {
                        ...issue.location_extent,
                        start: {
                            ...issue.location_extent.start,
                            line_num: 1,
                            column_num: 1,
                        },
                        end: {
                            ...issue.location_extent.end,
                            line_num: 1,
                            column_num: 1000,
                        }
                    }
                })
            }
            logger(`readyToParse->reported_issues`, JSON.stringify(reported_issues))

            return mapYcmDiagnosticToLanguageServerDiagnostic(reported_issues).filter(it => !!it.range)
        } catch (err) {
            return []
        }
    }

    public async fixIt(documentUri: string, position: Position, documents: TextDocuments) {
        const response = await this.runCompleterCommand(documentUri, position, documents, 'FixIt')
        const fixits = response.fixits as YcmFixIt[]
        const uri = crossPlatformUri(documentUri)
        fixits.forEach(it => {
            if (it.text.indexOf(uri) !== -1)
                it.text = it.text.replace(`${uri}:`, '')
        })
        return fixits
    }

    public async currentIdentifierFinished(documentUri: string, documents: TextDocuments) {
        await this.eventNotification(documentUri, null, documents, 'CurrentIdentifierFinished')
    }

    public async insertLeave(documentUri: string, documents: TextDocuments) {
        await this.eventNotification(documentUri, null, documents, 'InsertLeave')
    }
}

export interface Settings {
    ycmd: {
        path: string
        global_extra_config: string
        python: string
        confirm_extra_conf: boolean
        debug: boolean
        enable_hover_type: boolean
        use_imprecise_get_type: boolean
    }
}
