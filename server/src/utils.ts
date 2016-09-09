import {YcmCompletionItem} from './ycm'
import {
	IPCMessageReader, IPCMessageWriter,
	createConnection, IConnection, TextDocumentSyncKind,
	TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
	InitializeParams, InitializeResult, TextDocumentPositionParams,
	CompletionItem, CompletionItemKind, Position
} from 'vscode-languageserver'
import * as _ from 'lodash'

export function mapYcmCompletionsToLanguageServerCompletions(CompletionItems: YcmCompletionItem[] = []): CompletionItem[] {
    return _.map(CompletionItems, (it) => {
        const item = {
            label: it.menu_text,
            detail: it.menu_text,
            insertText: it.insertion_text,
            sortText: it.extra_menu_info
        } as CompletionItem
        switch(it.kind) {
            case 'FUNCTION': item.kind = CompletionItemKind.Function; break;
            case 'VARIABLE': item.kind = CompletionItemKind.Variable; break;
            case 'CLASS': item.kind = CompletionItemKind.Class; break;
            default: item.kind = CompletionItemKind.Text; break;
        }
        return item
    })
}