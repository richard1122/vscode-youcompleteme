import {
    IPCMessageReader, IPCMessageWriter,
    createConnection, IConnection, TextDocumentSyncKind,
    TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
    InitializeParams, InitializeResult, TextDocumentPositionParams,
    CompletionItem, CompletionItemKind, Position, Hover, MarkedString, Location
} from 'vscode-languageserver'
import * as _ from 'lodash'
import * as Buffer from 'buffer'
import Uri from 'vscode-uri'
const iconv = require('iconv-lite')

export function mapYcmCompletionsToLanguageServerCompletions(CompletionItems: YcmCompletionItem[] = []): CompletionItem[] {
    const len = CompletionItems.length.toString().length
    return _.map(CompletionItems, (it, index) => {
        const item = {
            label: it.menu_text || it.insertion_text,
            detail: it.extra_menu_info,
            insertText: it.insertion_text,
            documentation: it.detailed_info,
            sortText: _.padStart(index.toString(), len, '0')
        } as CompletionItem
        switch (it.kind || it.extra_menu_info) {
            case 'TYPE':
            case 'STRUCT':
                item.kind = CompletionItemKind.Interface
                break
            case 'ENUM':
                item.kind = CompletionItemKind.Enum
                break
            case 'MEMBER':
                item.kind = CompletionItemKind.Property
                break
            case 'MACRO':
                item.kind = CompletionItemKind.Keyword
                break
            case 'NAMESPACE':
                item.kind = CompletionItemKind.Module
                break
            case 'UNKNOWN':
                item.kind = CompletionItemKind.Value
                break
            case 'FUNCTION':
                item.kind = CompletionItemKind.Function
                break
            case 'VARIABLE':
                item.kind = CompletionItemKind.Variable
                break
            case 'CLASS':
                item.kind = CompletionItemKind.Class
                break
            case '[File]':
            case '[Dir]':
            case '[File&Dir]':
                item.kind = CompletionItemKind.File
                break
            default:
                item.kind = CompletionItemKind.Text
                break
        }
        return item
    })
}

export function mapYcmDiagnosticToLanguageServerDiagnostic(items: YcmDiagnosticItem[]): Diagnostic[] {
    return _.map(items, (it, index) => {
        const item = {
            range: null,
            source: 'ycm',
            message: it.text,
            code: it.fixit_available ? 'FixIt' : null
        } as Diagnostic

        let range = it.location_extent
        if (!(range.start.line_num > 0 && range.end.line_num > 0))
            range = it.ranges.length > 0 ? it.ranges[0] : null
        if (!!range) item.range = {
            start: {
                line: range.start.line_num - 1,
                character: range.start.column_num - 1
            },
            end: {
                line: range.end.line_num - 1,
                character: range.end.column_num - 1
            }
        }
        if (!item.range && it.location.column_num > 0 && it.location.line_num > 0) {
            item.range = {
                start: {
                    line: it.location.line_num - 1,
                    character: it.location.column_num - 1
                },
                end: {
                    line: it.location.line_num - 1,
                    character: it.location.column_num - 1
                }
            }
        }

        // FIXME: is there any other kind?
        switch (it.kind) {
            case 'ERROR':
                item.severity = DiagnosticSeverity.Error
                break
            case 'WARNING':
                item.severity = DiagnosticSeverity.Warning
                break
            default:
                item.severity = DiagnosticSeverity.Information
                break
        }
        return item
    })
}

export function mapYcmTypeToHover(res: YcmGetTypeResponse, language: string): Hover | null {
    if (res.message === 'Unknown type') return null
    if (res.message === 'Internal error: cursor not valid') return null
    logger('mapYcmTypeToHover', `language: ${language}`)
    return {
        contents: {
            language: language,
            value: res.message
        } as MarkedString
    } as Hover
}

export function mapYcmLocationToLocation(location: YcmLocation): Location {
    return {
        uri: Uri.file(location.filepath).toString(),
        range: {
            start: {
                line: location.line_num - 1,
                character: location.column_num - 1
            },
            end: {
                line: location.line_num - 1,
                character: location.column_num - 1
            },
        }
    } as Location
}

export function crossPlatformBufferToString(buffer: Buffer): string {
    return buffer.toString('utf8')
}

export function crossPlatformUri(uri: string) {
    return Uri.parse(uri).fsPath
}

let isDebug = false

export function loggerInit(debug: boolean) {
    isDebug = debug
}

export function logger(tag: string, ...args: any[]) {
    args.unshift(`[${tag}]`)
    /* tslint:disable:no-console */
    if (isDebug) console.log.apply(console, args)
    /* tslint:enable:no-console */
}

let extensions = new Map<string, string>()
extensions.set('objective-c', 'objc')
export function mapVSCodeLanguageIdToYcmFileType(languageId: string) {
    const type = extensions.get(languageId)
    if (type) return type
    else return languageId
}
