/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

'use strict'
import {MapYcmFixItToVSCodeEdit} from './utils'

import * as path from 'path'

import { workspace, Disposable, ExtensionContext, window, commands } from 'vscode'
import { LanguageClient, LanguageClientOptions, SettingMonitor, ServerOptions, TransportKind } from 'vscode-languageclient'

let client: LanguageClient
let disposable: Disposable

export function activate(context: ExtensionContext) {

    // The server is implemented in node
    let serverModule = context.asAbsolutePath(path.join('server', 'server.js'))
    // The debug options for the server
    let debugOptions = { execArgv: ['--nolazy', '--debug=6004'] }

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    let serverOptions: ServerOptions = {
        run : { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    }

    const languages = workspace.getConfiguration('ycmd').get('enabled_languages') as string[]
    // Options to control the language client
    let clientOptions: LanguageClientOptions = {
        // Register the server for plain text documents
        documentSelector: languages,
        synchronize: {
            // Synchronize the setting section 'languageServerExample' to the server
            configurationSection: 'ycmd',
        }
    }

    // Create the language client and start the client.
    client = new LanguageClient('ycm-language-server', serverOptions, clientOptions)
    client.onReady().then(() => {
        client.onNotification('error', (params) => {
            window.showErrorMessage(`[ycm] ${params}`)
        })
    })

    disposable = client.start()

    commands.registerCommand('ycm.lint', (args) => {
        client.sendNotification('lint', window.activeTextEditor.document.uri.toString())
    })

    commands.registerCommand('ycm.FixIt', async (args) => {
        const fixit = args as YcmFixIt
        const edits = MapYcmFixItToVSCodeEdit(fixit)
        const success = await workspace.applyEdit(edits)
        client.sendNotification('lint', window.activeTextEditor.document.uri.toString())
    })

    // Push the disposable to the context's subscriptions so that the
    // client can be deactivated on extension deactivation
    context.subscriptions.push(disposable)

    // workspace.onDidChangeTextDocument((event) => {
    //     let whenToLint = workspace.getConfiguration('ycmd').get('lint_run') as string
    //     if (whenToLint === 'onType') {
    //         client.sendNotification('lint', window.activeTextEditor.document.uri.toString())
    //     }
    // })

    workspace.onDidSaveTextDocument((event) => {
        let whenToLint = workspace.getConfiguration('ycmd').get('lint_run') as string
        if (whenToLint === 'onSave') {
            client.sendNotification('lint', window.activeTextEditor.document.uri.toString())
        }
    })
}
