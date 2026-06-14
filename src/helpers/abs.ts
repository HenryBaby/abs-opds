import * as builder from 'xmlbuilder'
import type { XMLNode } from 'xmlbuilder'
import type { Library, LibraryItem } from '../types/library.js'
import { serverURL, useProxy } from '../index.js'
import type { InternalUser } from '../types/internal.js'
import type { Request } from 'express'
import localize from '../i18n/i18n.js'
import { buildDownloadFilename, getDownloadMimeType } from './download.js'

export const OPDS_CATEGORY_TYPES = ['all', 'recent', 'authors', 'narrators', 'genres', 'series'] as const
export type OpdsCategory = (typeof OPDS_CATEGORY_TYPES)[number]

export interface OPDSXMLSkeletonOptions {
    endOfPage?: boolean
    library?: Library
    pageSize?: number
    request?: Request
    totalItems?: number
    updated?: string
    user?: InternalUser
}

function getQueryValue(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value
    }

    if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0]
    }

    return undefined
}

function getCurrentPage(request: Request): number {
    const page = Number.parseInt(getQueryValue(request.query.page) || '', 10)
    return Number.isFinite(page) && page > 0 ? page : 0
}

function getPaginationBaseUrl(request: Request): string {
    const [path, queryString] = request.originalUrl.split('?')
    const query = new URLSearchParams(queryString || '')
    query.delete('page')

    const serializedQuery = query.toString()
    return serializedQuery ? `${path}?${serializedQuery}` : path
}

export function buildOPDSXMLSkeleton(
    id: string,
    title: string,
    entriesXML: XMLNode[],
    options: OPDSXMLSkeletonOptions = {}
): string {
    const {
        endOfPage,
        library,
        pageSize = 20,
        request,
        totalItems,
        updated = new Date().toISOString(),
        user
    } = options
    const xml = builder
        .create('feed', { version: '1.0', encoding: 'UTF-8' })
        .att('xmlns', 'http://www.w3.org/2005/Atom')
        .att('xmlns:opds', 'http://opds-spec.org/2010/catalog')
        .att('xmlns:dcterms', 'http://purl.org/dc/terms/')
        .att('xmlns:opensearch', 'http://a9.com/-/spec/opensearch/1.1/')
        .ele('id', id)
        .up()
        .ele('title', title)
        .up()
        .ele('authentication')
        .ele('type', 'http://opds-spec.org/auth/basic')
        .up()
        .ele('labels')
        .ele('login', 'Card')
        .up()
        .ele('password', 'PW')
        .up()
        .up()
        .up()
        .ele('updated', updated)
        .up()

    // If there are entries, append them using raw
    if (entriesXML && entriesXML.length > 0) {
        entriesXML.forEach((entry) => {
            xml.importDocument(entry)
        })
    }

    if (library && user && request) {
        xml.ele('link', {
            rel: 'alternate',
            type: 'text/html',
            title: 'Web Interface',
            href: `/library/${library.id}`
        })

        // Search
        xml.ele('link', {
            rel: 'search',
            type: 'application/opensearchdescription+xml',
            title: 'Search this library',
            href: `/opds/libraries/${library.id}/search-definition`
        })

        // Backfall search? Works with Moonreader
        xml.ele('link', {
            rel: 'search',
            type: 'application/atom+xml',
            title: 'Search this library',
            href: `/opds/libraries/${library.id}?q={searchTerms}`
        })

        // OpenSearch elements for pagination information
        if (totalItems !== undefined) {
            const currentPage = getCurrentPage(request)
            const startIndex = currentPage * pageSize + 1 // 1-based index for OpenSearch
            const itemsOnPage = Math.max(0, Math.min(pageSize, totalItems - currentPage * pageSize))

            xml.ele('opensearch:totalResults', totalItems.toString()).up()
            xml.ele('opensearch:startIndex', startIndex.toString()).up()
            xml.ele('opensearch:itemsPerPage', itemsOnPage.toString()).up()
        }
        // Pagination
        const baseUrl = getPaginationBaseUrl(request)
        const separator = baseUrl.includes('?') ? '&' : '?'
        const currentPage = getCurrentPage(request)

        let totalPages = 0
        if (totalItems !== undefined) {
            totalPages = Math.ceil(totalItems / pageSize)
        }

        // First page link (start)
        xml.ele('link', {
            rel: 'start',
            type: 'application/atom+xml;profile=opds-catalog;kind=navigation',
            href: baseUrl
        })

        // First page link for paged feeds
        xml.ele('link', {
            rel: 'first',
            type: 'application/atom+xml;profile=opds-catalog;kind=acquisition',
            href: baseUrl
        })

        // Previous page link
        if (currentPage > 0) {
            const prevPage = currentPage - 1
            xml.ele('link', {
                rel: 'previous',
                type: 'application/atom+xml;profile=opds-catalog;kind=acquisition',
                href: baseUrl + (prevPage > 0 ? `${separator}page=${prevPage}` : '')
            })
        }

        // Next page link
        if (!endOfPage) {
            const nextPage = currentPage + 1
            xml.ele('link', {
                rel: 'next',
                type: 'application/atom+xml;profile=opds-catalog;kind=acquisition',
                href: baseUrl + `${separator}page=${nextPage}`
            })
        }

        // Last page link
        if (totalPages > 1) {
            const lastPage = totalPages - 1
            xml.ele('link', {
                rel: 'last',
                type: 'application/atom+xml;profile=opds-catalog;kind=acquisition',
                href: baseUrl + `${separator}page=${lastPage}`
            })
        }
    }

    return xml.end({ pretty: false })
}

export function buildLibraryEntries(
    libraries: Library[],
    user: InternalUser,
    updated = new Date().toISOString()
): XMLNode[] {
    // Create entries without XML declaration by using builder options
    return libraries.flatMap((library) => [
        builder
            .create('entry', { headless: true })
            .ele('id', library.id)
            .up()
            .ele('title', library.name)
            .up()
            .ele('updated', updated)
            .up()
            .ele('link', {
                type: 'application/atom+xml;profile=opds-catalog',
                rel: 'subsection',
                href: `/opds/libraries/${library.id}?categories=true`
            })
            .up()
    ])
}

export function buildCategoryEntries(
    libraryId: string | string[],
    user: InternalUser,
    lang?: string | string[],
    enabledCategories: readonly OpdsCategory[] = OPDS_CATEGORY_TYPES,
    updated = new Date().toISOString()
): XMLNode[] {
    if (Array.isArray(libraryId)) {
        return []
    }
    const entries: Record<OpdsCategory, XMLNode> = {
        all: builder
            .create('entry', { headless: true })
            .ele('id', libraryId)
            .up()
            .ele('title', localize('category.all', lang))
            .up()
            .ele('updated', updated)
            .up()
            .ele('link', {
                type: 'application/atom+xml;profile=opds-catalog',
                rel: 'subsection',
                href: `/opds/libraries/${libraryId}`
            })
            .up(),
        recent: builder
            .create('entry', { headless: true })
            .ele('id', 'recent')
            .up()
            .ele('title', localize('category.recent', lang))
            .up()
            .ele('updated', updated)
            .up()
            .ele('link', {
                type: 'application/atom+xml;profile=opds-catalog',
                rel: 'subsection',
                href: `/opds/libraries/${libraryId}?sort=recent`
            })
            .up(),
        authors: builder
            .create('entry', { headless: true })
            .ele('id', 'authors')
            .up()
            .ele('title', localize('category.authors', lang))
            .up()
            .ele('updated', updated)
            .up()
            .ele('link', {
                type: 'application/atom+xml;profile=opds-catalog',
                rel: 'subsection',
                href: `/opds/libraries/${libraryId}/authors`
            })
            .up(),
        narrators: builder
            .create('entry', { headless: true })
            .ele('id', 'narrators')
            .up()
            .ele('title', localize('category.narrators', lang))
            .up()
            .ele('updated', updated)
            .up()
            .ele('link', {
                type: 'application/atom+xml;profile=opds-catalog',
                rel: 'subsection',
                href: `/opds/libraries/${libraryId}/narrators`
            })
            .up(),
        genres: builder
            .create('entry', { headless: true })
            .ele('id', 'genres')
            .up()
            .ele('title', localize('category.genres', lang))
            .up()
            .ele('updated', updated)
            .up()
            .ele('link', {
                type: 'application/atom+xml;profile=opds-catalog',
                rel: 'subsection',
                href: `/opds/libraries/${libraryId}/genres`
            })
            .up(),
        series: builder
            .create('entry', { headless: true })
            .ele('id', 'series')
            .up()
            .ele('title', localize('category.series', lang))
            .up()
            .ele('updated', updated)
            .up()
            .ele('link', {
                type: 'application/atom+xml;profile=opds-catalog',
                rel: 'subsection',
                href: `/opds/libraries/${libraryId}/series`
            })
            .up()
    }

    return enabledCategories.map((category) => entries[category])
}

export function buildCardEntries(
    items: string[],
    type: string | string[],
    user: InternalUser,
    libraryId: string | string[],
    updated = new Date().toISOString()
): XMLNode[] {
    return items.map((item) => {
        const libraryIdValue = Array.isArray(libraryId) ? libraryId[0] || '' : libraryId
        const typeValue = Array.isArray(type) ? type[0] || '' : type
        const query = new URLSearchParams({
            name: item,
            type: typeValue
        })

        return builder
            .create('entry', { headless: true })
            .ele('id', item.toLowerCase().replace(' ', '-'))
            .up()
            .ele('title', item)
            .up()
            .ele('updated', updated)
            .up()
            .ele('link', {
                type: 'application/atom+xml;profile=opds-catalog',
                rel: 'subsection',
                href: `/opds/libraries/${encodeURIComponent(libraryIdValue)}?${query.toString()}`
            })
            .up()
    })
}

export function buildCustomCardEntries(
    items: { item: string; link: string }[],
    updated = new Date().toISOString()
): XMLNode[] {
    return items.map((item) => {
        return builder
            .create('entry', { headless: true })
            .ele('id', item.item.toLowerCase().replace(' ', '-'))
            .up()
            .ele('title', item.item)
            .up()
            .ele('updated', updated)
            .up()
            .ele('link', {
                type: 'application/atom+xml;profile=opds-catalog',
                rel: 'subsection',
                href: item.link
            })
            .up()
    })
}

function buildEbookDownloadUrl(item: LibraryItem, user: InternalUser): string {
    const query = new URLSearchParams({
        format: item.format || '',
        token: user.apiKey
    })

    const filename = encodeURIComponent(buildDownloadFilename(item.title, item.format))

    return `/opds/download/${encodeURIComponent(item.id)}/${filename}?${query.toString()}`
}

function buildCoverUrl(item: LibraryItem, user: InternalUser): string {
    const query = new URLSearchParams({
        token: user.apiKey
    })

    return `/opds/cover/${encodeURIComponent(item.id)}?${query.toString()}`
}

function getItemUpdated(item: LibraryItem, fallback: string): string {
    const timestamp = Date.parse(item.addedAt)
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback
}

export function buildItemEntries(
    libraryItems: LibraryItem[],
    user: InternalUser,
    updated = new Date().toISOString()
): XMLNode[] {
    const linkUrl = useProxy ? `/opds/proxy` : `${serverURL}`

    return libraryItems.map((item) => {
        const authors = item.authors
        const downloadUrl = item.format
            ? buildEbookDownloadUrl(item, user)
            : `${linkUrl}/api/items/${item.id}/download?token=${user.apiKey}`
        const coverUrl = buildCoverUrl(item, user)

        let xml = builder
            .create('entry', { headless: true })
            .ele('id', `urn:uuid:${item.id}`)
            .up()
            .ele('title', item.title)
            .up()
            .ele('subtitle', item.subtitle)
            .up()
            .ele('updated', getItemUpdated(item, updated))
            .up()
            .ele('content', { type: 'text' }, item.description)
            .up()
            .ele('publisher', item.publisher)
            .up()
            .ele('isbn', item.isbn)
            .up()
            .ele('published', item.publishedYear)
            .up()
            .ele('language', item.language)
            .up()
            .ele('link', {
                href: downloadUrl,
                rel: 'http://opds-spec.org/acquisition',
                type: item.format ? getDownloadMimeType(item.format) : 'application/octet-stream'
            })
            .up()
            .ele('link', {
                href: coverUrl,
                rel: 'http://opds-spec.org/image',
                type: 'image/webp'
            })
            .up()
            .ele('link', {
                href: coverUrl,
                rel: 'http://opds-spec.org/image',
                type: 'image/png'
            })
            .up()

        for (let author of authors) {
            xml.ele('author').ele('name', author.name).up().up()
        }
        for (let tag of [...item.genres, ...item.tags]) {
            xml.ele('category', { label: tag, term: tag }).up()
        }

        return xml
    })
}

export function buildSearchDefinition(id: string | string[], user: InternalUser) {
    return builder
        .create('OpenSearchDescription', { version: '1.0', encoding: 'UTF-8' })
        .att('xmlns', 'http://a9.com/-/spec/opensearch/1.1/')
        .att('xmlns:atom', 'http://www.w3.org/2005/Atom')
        .ele('ShortName', 'ABS')
        .up()
        .ele('LongName', 'Audiobookshelf')
        .up()
        .ele('Description', 'Search for books in Audiobookshelf')
        .up()
        .ele('Url', {
            type: 'application/atom+xml;profile=opds-catalog;kind=acquisition',
            template: `/opds/libraries/${id}?q={searchTerms}&amp;author={atom:author}&amp;title={atom:title}`
        })
        .up()
        .end({ pretty: false })
}
