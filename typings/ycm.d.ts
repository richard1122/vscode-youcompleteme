export type CompletionItem = {
    menu_text: string
    insertion_text: string
    detailed_info: string
    extra_menu_info: string
    kind: string
}

export type Location = {
    filepath: string
    column_num: number
    line_num: number
}

export type Range = {
    start: Location
    end: Location
}

export type DiagnosticItem = {
    kind: 'ERROR' | 'WARNING'
    text: string
    ranges: Range[]
    location: Location
    location_extent: Range
    fixit_available: boolean
}

export type FixIt = {
    chunks: {
        range: Range
        replacement_text: string
    }[]
    text: string
    locationtion: Location
}

export type GetTypeResponse = {
    message: string
}