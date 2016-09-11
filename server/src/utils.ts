import {YcmCompletionItem, YcmDiagnosticItem} from './ycm'
import {
	IPCMessageReader, IPCMessageWriter,
	createConnection, IConnection, TextDocumentSyncKind,
	TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
	InitializeParams, InitializeResult, TextDocumentPositionParams,
	CompletionItem, CompletionItemKind, Position
} from 'vscode-languageserver'
import * as _ from 'lodash'

export function mapYcmCompletionsToLanguageServerCompletions(CompletionItems: YcmCompletionItem[] = []): CompletionItem[] {
    const len = CompletionItems.length.toString().length
    return _.map(CompletionItems, (it, index) => {
        const item = {
            label: it.menu_text,
            detail: it.extra_menu_info,
            insertText: it.insertion_text,
            documentation: it.detailed_info,
            sortText: _.padStart(index.toString(), len, '0')
        } as CompletionItem
        switch(it.kind) {
            case 'TYPE', 'STRUCT': item.kind = CompletionItemKind.Interface; break;
            case 'ENUM': item.kind = CompletionItemKind.Enum; break;
            case 'MEMBER': item.kind = CompletionItemKind.Property; break;
            case 'MACRO': item.kind = CompletionItemKind.Keyword; break;
            case 'NAMESPACE': item.kind = CompletionItemKind.Module; break;
            case 'UNKNOWN': item.kind = CompletionItemKind.Value; break;
            case 'FUNCTION': item.kind = CompletionItemKind.Function; break;
            case 'VARIABLE': item.kind = CompletionItemKind.Variable; break;
            case 'CLASS': item.kind = CompletionItemKind.Class; break;
            case '[File]', '[Dir]', '[File&Dir]': item.kind = CompletionItemKind.File; break;
            default: item.kind = CompletionItemKind.Text; break;
        }
        return item
    })
}

export function mapYcmDiagnosticToLanguageServerDiagnostic(items: YcmDiagnosticItem[]): Diagnostic[] {
    return _.map(items, (it, index) => {
        const item = {
            range: null,
            source: 'ycm',
            message: it.text
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

        //FIXME: is there any other kind?
        switch (it.kind) {
            case 'ERROR': item.severity = DiagnosticSeverity.Error; break;
            case 'WARNING': item.severity = DiagnosticSeverity.Warning; break;
            default: item.severity = DiagnosticSeverity.Information; break;
        }
        return item
    })
}