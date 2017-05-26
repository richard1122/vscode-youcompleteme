import { WorkspaceEdit, Uri, TextEdit, Position, Range} from 'vscode'

export function MapYcmFixItToVSCodeEdit(fixIt: YcmFixIt): WorkspaceEdit {
    const chunks = YcmFixItToChunkFiles(fixIt)
    const edit = new WorkspaceEdit()

    chunks.forEach((fixes, file) => {
        const uri = Uri.file(file)
        const edits = fixes.map(it => {
            const locationEqual = YcmLocationEquals(it.range.start, it.range.end)
            const replacementAvailable = !!it.replacement_text

            // Insert
            if (locationEqual && replacementAvailable) {
                return TextEdit.insert(
                    YcmLocationToVSCodePosition(it.range.start),
                    it.replacement_text)
            }

            // Replace
            if (!locationEqual && replacementAvailable) {
                return TextEdit.replace(
                    YcmRangeToVSCodeRange(it.range),
                    it.replacement_text
                )
            }

            // Delete
            // FixMe
            if (!locationEqual && !replacementAvailable) {
                return TextEdit.delete(YcmRangeToVSCodeRange(it.range))
            }
        })
        edit.set(uri, edits)
    })
    return edit
}

function YcmRangeToVSCodeRange(range: YcmRange) {
    return new Range(
        YcmLocationToVSCodePosition(range.start),
        YcmLocationToVSCodePosition(range.end))
}

function YcmLocationToVSCodePosition(location: YcmLocation) {
    return new Position(location.line_num - 1, location.column_num - 1)
}

function YcmLocationEquals(a: YcmLocation, b: YcmLocation): boolean {
    return a.filepath === b.filepath && a.column_num === b.column_num && a.line_num === b.line_num
}

function YcmFixItToChunkFiles(fixIts: YcmFixIt): Map<string, YcmChunk[]> {
    const map: Map<string, YcmChunk[]> = new Map()
    fixIts.chunks.forEach(it => {
        const filepath = it.range.start.filepath
        const arr = map.get(filepath) || []
        arr.push(it)
        map.set(filepath, arr)
    })
    return map
}
