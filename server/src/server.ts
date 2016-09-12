/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict'

import {
	IPCMessageReader, IPCMessageWriter,
	createConnection, IConnection, TextDocumentSyncKind,
	TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
	InitializeParams, InitializeResult, TextDocumentPositionParams,
	CompletionItem, CompletionItemKind
} from 'vscode-languageserver'
import Ycm, {Settings} from './ycm'
import * as _ from 'lodash'
import {logger} from './utils'

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process))

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments()
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection)

// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilites. 
let workspaceRoot: string
let workspaceConfiguration: Settings;

connection.onInitialize((params): InitializeResult => {
	workspaceRoot = params.rootPath
	return {
		capabilities: {
			// Tell the client that the server works in FULL text document sync mode
			textDocumentSync: documents.syncKind,
			// Tell the client that the server support code complete
			completionProvider: {
				resolveProvider: true,
                triggerCharacters: [".", "->"]
			}
		}
	}
})

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(async (change) => {
    logger(`onDidChangeContent ${JSON.stringify(change.document.uri)}`)
    const ycm = await getYcm()
    // connection.sendDiagnostics({
    //     uri: change.document.uri,
    //     diagnostics: await ycm.readyToParse(change.document, documents)
    // })
    ycm.insertLeave(change.document, documents)
    ycm.currentIdentifierFinished(change.document, documents)
    // await getIssues(change.document)
	// validateTextDocument(change.document)
})

// The settings interface describe the server relevant settings part

function getYcm(): Promise<Ycm> {
    logger(`getYcm: ${workspaceRoot}, config: ${JSON.stringify(workspaceConfiguration)}`)
    if (workspaceRoot == null || workspaceConfiguration == null)
        return new Promise<Ycm>((resolve, reject) => setTimeout(() => getYcm(), 100))
    try {
        return Ycm.getInstance(workspaceRoot, workspaceConfiguration)
    } catch (err) {
        connection.window.showWarningMessage('Ycm startup failed. Please check your ycmd path or python execuable path.')
    }
}

async function getIssues(document: TextDocument) {
    const ycm = await getYcm()
    connection.sendDiagnostics({
        uri: document.uri,
        diagnostics: await ycm.readyToParse(document, documents)
    })
}

connection.onSignatureHelp((event) => {
    logger(`onSignatureHelp: ${JSON.stringify(event)}`)
    return null
})


// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration(async (change) => {
	let settings = <Settings>change.settings
    logger(JSON.stringify(settings))
    try {
        ensureValidConfiguration(settings)
    } catch(err) {
        connection.window.showErrorMessage(`[Ycm] ${err.message || err}`)
        return
    }
    workspaceConfiguration = settings
    logger(`onDidChangeConfiguration: ${workspaceConfiguration}`)
    await getYcm()
	// Revalidate any open text documents
	// documents.all().forEach(validateTextDocument)
})

function ensureValidConfiguration(settings: Settings) {
    if (!settings.ycmd || !settings.ycmd.path)
        throw new Error("Invalid ycm path")
    if (!settings.ycmd.global_extra_config)
        throw new Error("Invalid ycm global extra config path")
}

documents.onDidOpen(async (event) => {
    logger(`onDidOpen: ${event.document.uri}`)
    const ycm = await getYcm()
    await ycm.getReady(event.document, documents)
})

// function validateTextDocument(textDocument: TextDocument): void {
// 	let diagnostics: Diagnostic[] = []
// 	let lines = textDocument.getText().split(/\r?\n/g)
// 	let problems = 0
// 	for (var i = 0; i < lines.length && problems < maxNumberOfProblems; i++) {
// 		let line = lines[i]
// 		let index = line.indexOf('typescript')
// 		if (index >= 0) {
// 			problems++
// 			diagnostics.push({
// 				severity: DiagnosticSeverity.Warning,
// 				range: {
// 					start: { line: i, character: index},
// 					end: { line: i, character: index + 10 }
// 				},
// 				message: `${line.substr(index, 10)} should be spelled TypeScript`,
// 				source: 'ex'
// 			})
// 		}
// 	}
// 	// Send the computed diagnostics to VSCode.
// 	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics })
// }

// connection.onDidChangeWatchedFiles((change) => {
// 	// Monitored files have change in VSCode
// 	connection.logger('We recevied an file change event')
// })

// This handler provides the initial list of the completion items.
connection.onCompletion(async (textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[]> => {
    logger(`onCompletion: ${textDocumentPosition.textDocument.uri}`)
    const ycm = await getYcm()
    // await ycm.insertLeave(documents.get(textDocumentPosition.textDocument.uri), documents)
    // await ycm.currentIdentifierFinished(documents.get(textDocumentPosition.textDocument.uri), documents)
    // await ycm.readyToParse(documents.get(textDocumentPosition.textDocument.uri), documents)
    const latestCompletions = await ycm.completion(documents.get(textDocumentPosition.textDocument.uri), textDocumentPosition.position, documents)
    return latestCompletions
})

// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	return item
})

connection.onExit(() => {
    getYcm().then(ycm => ycm.reset())
})

// connection.onDidOpenTextDocument((params) => {
// 	// A text document got opened in VSCode.
// 	// params.uri uniquely identifies the document. For documents store on disk this is a file URI.
// 	// params.text the initial full content of the document.
//     ycm.readyToParse(documents.get(params.textDocument.uri))
// })

// connection.onDidChangeTextDocument((params) => {
// 	// The content of a text document did change in VSCode.
// 	// params.uri uniquely identifies the document.
// 	// params.contentChanges describe the content changes to the document.
// 	connection.logger(`onDidChangeTextDocument: ${JSON.stringify(params.textDocument.version)}`)
// })
/*
connection.onDidCloseTextDocument((params) => {
	// A text document got closed in VSCode.
	// params.uri uniquely identifies the document.
	connection.logger(`${params.uri} closed.`);
});
*/

connection.onNotification<string>({
    method: 'lint'
}, (uri) => {
    getIssues(documents.get(uri))
})

// Listen on the connection
connection.listen()