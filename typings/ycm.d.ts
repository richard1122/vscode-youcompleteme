export type YcmCompletionItem = {
    menu_text: string
    insertion_text: string
    detailed_info: string
    extra_menu_info: string
    kind: string
}

export type YcmLocation = {
    filepath: string
    column_num: number
    line_num: number
}

export type YcmRange = {
    start: YcmLocation
    end: YcmLocation
}

export type YcmDiagnosticItem = {
    kind: 'ERROR' | 'WARNING'
    text: string
    ranges: YcmRange[]
    location: YcmLocation
    location_extent: YcmRange
    fixit_available: boolean
}

export type YcmFixIt = {
    chunks: {
        range: YcmRange
        replacement_text: string
    }[]
    text: string
    locationtion: YcmLocation
}

export type YcmGetTypeResponse = {
    message: string
}