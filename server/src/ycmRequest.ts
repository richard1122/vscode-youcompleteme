import * as crypto from 'crypto'
import * as url from 'url'
import * as _ from 'lodash'
import * as http from 'http'
import * as qs from 'querystring'

import {
    IPCMessageReader, IPCMessageWriter,
    createConnection, IConnection, TextDocumentSyncKind,
    TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
    InitializeParams, InitializeResult, TextDocumentPositionParams,
    CompletionItem, CompletionItemKind, Position, Location, RemoteWindow,
    MessageActionItem
} from 'vscode-languageserver'

import {
    crossPlatformUri,
    logger
} from './utils'

export default class YcmRequest {
    private workingDir: string
    private documentUri: string
    private position: Position
    private documents: TextDocuments
    private event: string

    private command: string

    private port: number
    private secret: Buffer

    private window: RemoteWindow

    public constructor(window: RemoteWindow, port: number, secret: Buffer, workingDir: string, currentDocument: string, position: Position, documents: TextDocuments)
    public constructor(window: RemoteWindow, port: number, secret: Buffer, workingDir: string, currentDocument: string, position: Position, documents: TextDocuments, event: string)
    public constructor(window: RemoteWindow, port: number, secret: Buffer, workingDir: string, currentDocument: string, position: Position = null, documents: TextDocuments = null, event: string = null) {
        this.workingDir = workingDir
        this.documentUri = currentDocument
        this.position = position
        this.documents = documents
        this.event = event

        this.port = port
        this.secret = secret

        this.window = window
    }

    public isCommand() {
        this.command = this.event
        this.event = null
        return this
    }

    private _request(endpoint: string, params: any,  method: 'POST' | 'GET' = 'POST') {
        return new Promise<any>((resolve, reject) => {
            logger('_request', JSON.stringify(params))
            const path = url.resolve('/', endpoint)
            let payload: string
            const message: http.RequestOptions = {
                port: this.port,
                host: 'localhost',
                method: method,
                path: path,
                headers: {}
            }
            if (method === 'GET') {
                message.path = `${message.path}?${qs.stringify(params)}`
            } else {
                payload = this.escapeUnicode(JSON.stringify(params))
                this.signMessage(message, path, payload)
                message.headers['Content-Type'] = 'application/json'
                message.headers['Content-Length'] = payload.length
            }
            const req = http.request(message, (res) => {
                logger('_request', `status code: ${res.statusCode}`)
                if (res.statusCode < 200 || res.statusCode > 299) reject(new Error('Network failed'))
                res.setEncoding('utf8')
                const mac = res.headers['x-ycm-hmac'] as string
                let response = ''
                res.on('data', (chunk) => {
                    response += chunk
                })
                res.on('end', () => {
                    logger('_request', response)
                    if (!this.verifyHmac(response, mac)) reject(new Error('Hmac check failed.'))
                    else resolve(JSON.parse(response))
                })
                res.on('error', (err) => {
                    reject(err)
                })
            })
            req.write(payload)
        })
    }

    public async request(endpoint: string = null, method: 'POST' | 'GET' = 'POST') {
        if (!endpoint) {
            if (!!this.event) endpoint = 'event_notification'
            if (!!this.command) endpoint = 'run_completer_command'
            if (!this.event && !this.command) throw new Error('endpoint could not be determained')
        }
        const params = this.buildRequest()
        const res = await this._request(endpoint, params)
        this.checkUnknownExtraConf(res)
        return res
    }

    private checkUnknownExtraConf(body: any) {
        if (!!body && _.isArray(body.errors) && body.errors.length === 1) {
            const error = body.errors[0] as YcmError
            if (error.exception.TYPE === 'UnknownExtraConf') {
                const unknownConfError = error as YcmExtraConfError
                const req = {filepath: unknownConfError.exception.extra_conf_file}
                this.window.showInformationMessage<ConfirmExtraConfActionItem>(`[Ycm] Found ${unknownConfError.exception.extra_conf_file}. Load? `, {
                    title: 'Load',
                    path: unknownConfError.exception.extra_conf_file
                }, {
                    title: 'Ignore',
                    path: unknownConfError.exception.extra_conf_file
                }).then(it => {
                    if (it.title === 'Load') {
                        this._request('/load_extra_conf_file', req)
                    } else {
                        this._request('/ignore_extra_conf_file', req)
                    }
                })
                throw new Error('ExtraConfFile question found.')
            }
        }
    }

    private buildRequest(): RequestType {
        const url = crossPlatformUri(this.documentUri)
        // const url = document.uri
        logger(`buildRequest`, `document, ${url}; position: ${this.position}; event: ${this.event}`)
        const params: RequestType = {
            filepath: url,
            working_dir: this.workingDir,
            file_data: { }
        }
        this.documents.all().forEach(it => {
            const url = crossPlatformUri(it.uri)
            params.file_data[url] = {
                contents: it.getText(),
                filetypes: [it.languageId]
            }
        })

        if (!!this.position) {
            params.line_num = this.position.line + 1
            params.column_num = this.position.character + 1
        } else {
            params.line_num = 1
            params.column_num = 1
        }

        if (!!this.event) {
            params.event_name = this.event
        }
        if (!!this.command) {
            params.command_arguments = [this.command]
            params.completer_target = 'filetype_default'
        }
        return params
    }

    private generateHmac(data: string | Buffer): Buffer
    private generateHmac(data: string | Buffer, encoding: 'base64'): string
    private generateHmac(data: string | Buffer, encoding: 'base64' = null): Buffer | string {
        return crypto.createHmac('sha256', this.secret).update(data).digest(encoding)
    }

    private async verifyHmac(data: string, hmac: string) {
        const hmac2 = await this.generateHmac(data, 'base64')
        if (!_.isString(hmac) || !_.isString(hmac2)) return false
        return hmac === hmac2
    }

    private signMessage(message: http.RequestOptions, path: string, payload: string) {
        const hmac = this.generateHmac(Buffer.concat([
            this.generateHmac(message.method),
            this.generateHmac(path),
            this.generateHmac(payload)]), 'base64')
        message.headers['X-Ycm-Hmac'] = hmac
    }

    private escapeUnicode(str: string) {
        const result: string[] = []
        for (const i of _.range(str.length)) {
            const char = str.charAt(i)
            const charCode = str.charCodeAt(i)
            if (charCode < 0x80) result.push(char)
            else result.push(('\\u' + ('0000' + charCode.toString(16)).substr(-4)))
        }
        return result.join('')
    }
}

export type RequestType = {
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
    },
    event_name?: string
    command_arguments?: string[],
    completer_target?: 'filetype_default'
}

export type YcmError = {
    exception: {
        TYPE: string,
        traceback: string
    }
}

export type YcmExtraConfError = YcmError & {
    exception: {
        extra_conf_file: string
    }
}

export interface ConfirmExtraConfActionItem extends MessageActionItem {
    path: string
}