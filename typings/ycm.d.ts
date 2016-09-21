type YcmCompletionItem = {
    menu_text: string
    insertion_text: string
    detailed_info: string
    extra_menu_info: string
    kind: string
}

type YcmLocation = {
    filepath: string
    column_num: number
    line_num: number
}

type YcmRange = {
    start: YcmLocation
    end: YcmLocation
}

type YcmDiagnosticItem = {
    kind: 'ERROR' | 'WARNING'
    text: string
    ranges: YcmRange[]
    location: YcmLocation
    location_extent: YcmRange
    fixit_available: boolean
}

type YcmChunk = {
    range: YcmRange
    replacement_text: string
}

type YcmFixIt = {
    chunks: YcmChunk[]
    text: string
    location: YcmLocation
}

type YcmGetTypeResponse = {
    message: string
}