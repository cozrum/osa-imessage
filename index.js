const fs = require('fs')
const path = require('path')
const osa = require('osa2')
const ol = require('one-liner')
const assert = require('assert')
const macosVersion = require('macos-version')

const versions = require('./macos_versions')
const currentVersion = macosVersion()

const messagesDb = require('./lib/messages-db.js')

function warn(str) {
    if (!process.env.SUPPRESS_OSA_IMESSAGE_WARNINGS) {
        console.error(ol(str))
    }
}

if (versions.broken.includes(currentVersion)) {
    console.error(
        ol(`This version of macOS \(${currentVersion}) is known to be
            incompatible with osa-imessage. Please upgrade either
            macOS or osa-imessage.`)
    )
    process.exit(1)
}

if (!versions.working.includes(currentVersion)) {
    warn(`This version of macOS \(${currentVersion}) is currently
          untested with this version of osa-imessage. Proceed with
          caution.`)
}

// Instead of doing something reasonable, Apple stores dates as the number of
// seconds since 01-01-2001 00:00:00 GMT. DATE_OFFSET is the offset in seconds
// between their epoch and unix time
const DATE_OFFSET = 978307200

// Gets the current Apple-style timestamp
function appleTimeNow() {
    return Math.floor(Date.now() / 1000) - DATE_OFFSET
}

// Gets the Apple-style timestamp
function appleTime(timestamp) {
    return Math.floor((timestamp || Date.now()) / 1000) - DATE_OFFSET
}

// Transforms an Apple-style timestamp to a proper unix timestamp
function fromAppleTime(ts) {
    if (ts == 0) {
        return null
    }

    // unpackTime returns 0 if the timestamp wasn't packed
    // TODO: see `packTimeConditionally`'s comment
    if (unpackTime(ts) != 0) {
        ts = unpackTime(ts)
    }

    return new Date((ts + DATE_OFFSET) * 1000)
}

// Since macOS 10.13 High Sierra, some timestamps appear to have extra data
// packed. Dividing by 10^9 seems to get an Apple-style timestamp back.
// According to a StackOverflow user, timestamps now have nanosecond precision
function unpackTime(ts) {
    return Math.floor(ts / Math.pow(10, 9))
}

// TODO: Do some kind of database-based detection rather than relying on the
// operating system version
function packTimeConditionally(ts) {
    if (macosVersion.is('>=10.13')) {
        return ts * Math.pow(10, 9)
    } else {
        return ts
    }
}

// Gets the proper handle string for a contact with the given name
function handleForName(name) {
    assert(typeof name == 'string', 'name must be a string')
    return osa(name => {
        const Messages = Application('Messages')
        return Messages.buddies.whose({ name: name })[0].handle()
    })(name)
}

// Gets the display name for a given handle
// TODO: support group chats
function nameForHandle(handle) {
    assert(typeof handle == 'string', 'handle must be a string')
    return osa(handle => {
        const Messages = Application('Messages')
        return Messages.buddies.whose({ handle: handle }).name()[0]
    })(handle)
}

// Sends a message to the given handle
async function send(handle, message) {
    assert(typeof handle == 'string', 'handle must be a string')
    assert(typeof message == 'string', 'message must be a string')

    await osa((handle, message) => {
        const Messages = Application('Messages')

        let target

        try {
            target = Messages.buddies.whose({ handle: handle })[0]
        } catch (e) {}

        try {
            target = Messages.textChats.byId('iMessage;-;+' + handle)()
        } catch (e) {}

        try {
            Messages.send(message, { to: target })
        } catch (e) {
            throw new Error(`no thread with handle '${handle}'`)
        }
    })(handle, message)

    return new Promise(async res => {
        const query = `
            SELECT
                id AS phoneNumber,
                m.guid as messageId,
                text as message,
                is_from_me as fromMe,
                is_sent as sent
            FROM message AS m
            LEFT JOIN handle AS h ON h.rowid = m.handle_id
            WHERE phoneNumber='+${handle}' OR phoneNumber='${handle}' AND message='${message}' AND sent=1 AND fromMe=1
            ORDER BY m.ROWID
            DESC
            LIMIT ${1}
            OFFSET ${0}
             `

        const db = await messagesDb.open()

        let messages = []

        while (true) {
            messages = await db.all(query)
            if (messages.length) {
                break
            }
            await new Promise(res => setTimeout(res, 100))
        }

        res(parseMessages(messages)[0])
    })
}

// Sends a message to the given handle
async function sendFile(handle, filePath) {
    assert(typeof handle == 'string', 'handle must be a string')
    assert(typeof filePath == 'string', 'filePath must be a string')
    await osa((handle, filePath) => {
        const Messages = Application('Messages')

        let target

        try {
            target = Messages.buddies.whose({ handle: handle })[0]
        } catch (e) {}

        try {
            target = Messages.textChats.byId('iMessage;-;+' + handle)()
        } catch (e) {}

        try {
            const msg = Path(filePath)
            Messages.send(msg, { to: target })
        } catch (e) {
            throw new Error(`no thread with handle '${handle}'`)
        }
    })(handle, filePath)

    const fileName = path.basename(filePath)

    return new Promise(async res => {
        const query = `
            SELECT
                id AS phoneNumber,
                m.guid as messageId,
                text as message,
                is_from_me as fromMe,
                is_sent as sent,
                transfer_name,
                cache_has_attachments
            FROM message AS m
            LEFT JOIN message_attachment_join AS maj ON message_id = m.rowid
            LEFT JOIN attachment AS a ON a.rowid = maj.attachment_id
            LEFT JOIN handle AS h ON h.rowid = m.handle_id
            WHERE phoneNumber='+${handle}' OR phoneNumber='${handle}' AND transfer_name='${fileName}' AND cache_has_attachments=1 AND sent=1 AND fromMe=1
            ORDER BY m.ROWID
            DESC
            LIMIT ${1}
            OFFSET ${0}
             `

        const db = await messagesDb.open()

        let messages = []

        while (true) {
            messages = await db.all(query)
            if (messages.length) {
                break
            }
            await new Promise(res => setTimeout(res, 100))
        }

        res(parseMessages(messages)[0])
    })
}

const ImageMimeTypes = [
    'image/bmp',
    'image/cis-cod',
    'image/gif',
    'image/ief',
    'image/png',
    'image/jpeg',
    'image/pipeg',
    'image/svg+xml',
    'image/tiff',
    'image/tiff',
    'image/x-cmu-raster',
    'image/x-cmx',
    'image/x-icon',
    'image/x-portable-anymap',
    'image/x-portable-bitmap',
    'image/x-portable-graymap',
    'image/x-portable-pixmap',
    'image/x-rgb',
    'image/x-xbitmap',
    'image/x-xpixmap',
    'image/x-xwindowdump',
]

/**
 *
 *
 * @param {object[]} msgs
 * @returns
 */
function parseMessages(msgs) {
    let prevRow = null

    return msgs
        .map(msg => {
            if (msg.filename) {
                let bb = prevRow && msg.id === prevRow.id ? prevRow : msg
                if (!bb.image_attachment_url) bb.image_attachment_url = []
                const path = msg.filename.replace(
                    '~/Library/Messages/Attachments',
                    ''
                )

                if (ImageMimeTypes.includes(msg.mime_type)) {
                    bb.image_attachment_url.push(path)
                } else {
                    if (!bb.attachment) bb.attachment = []
                    bb.attachment.push({
                        path,
                        mime_type: msg.mime_type,
                    })
                }
            }

            if (prevRow && msg.id === prevRow.id) {
                return null
            }

            msg.time = fromAppleTime(msg.time)

            delete msg.mime_type
            delete msg.filename
            msg.message = msg.message ? msg.message.replace(/\uFFFC/g, '') : ''

            msg.fromMe = !!msg.fromMe

            prevRow = msg
            return msg
        })
        .filter(f => f)
}

let emitter = null
let emittedMsgs = {}
function listen(lastTime) {
    // If listen has already been run, return the existing emitter
    if (emitter != null) {
        return emitter
    }

    // Create an EventEmitter
    emitter = new (require('events')).EventEmitter()

    let last = lastTime || packTimeConditionally(appleTime())
    let bail = false

    const dbPromise = messagesDb.open()

    async function check() {
        const db = await dbPromise
        const query = `
            SELECT               
                m.rowid as id,
                date as time, 
                id AS phoneNumber,
                m.guid as messageId,
                text as message,
                mime_type,
                filename,
                is_from_me as fromMe
            FROM message as m
            LEFT JOIN message_attachment_join AS maj ON message_id = m.rowid
            LEFT JOIN attachment AS a ON a.rowid = maj.attachment_id
            LEFT JOIN handle AS h ON h.rowid = m.handle_id
            WHERE time >= ${last}
            `
            console.log("TCL: check -> last", last)

        try {
            const messages = await db.all(query)
            console.log("TCL: check -> messages", messages)
            if (messages.length) {
                last =
                    messages[messages.length - 1].time ||
                    packTimeConditionally(appleTimeNow())

                parseMessages(messages).forEach(msg => {
                    if (emittedMsgs[msg.messageId]) return
                    emittedMsgs[msg.messageId] = { time: last }
                    emitter.emit('message', msg)
                })
            }

            setTimeout(check, 500)
        } catch (err) {
            bail = true
            emitter.emit('error', err)
            warn(`sqlite returned an error while polling for new messages!
                  bailing out of poll routine for safety. new messages will
                  not be detected`)
        }
    }

    if (bail) return
    check()

    function emptyEmittedMsgs() {
        Object.keys(emittedMsgs).keys(messageId => {
            if (emittedMsgs[messageId].time < last) {
                delete emittedMsgs[messageId]
            }
        })

        emitter.emit('changeLast', last)
    }

    setInterval(emptyEmittedMsgs, 10000)

    return emitter
}

async function getRecentChats(limit = 10) {
    const db = await messagesDb.open()

    const query = `
        SELECT
            guid as id,
            chat_identifier as recipientId,
            service_name as serviceName,
            room_name as roomName,
            display_name as displayName
        FROM chat
        JOIN chat_handle_join ON chat_handle_join.chat_id = chat.ROWID
        JOIN handle ON handle.ROWID = chat_handle_join.handle_id
        ORDER BY handle.rowid DESC
        LIMIT ${limit};
    `

    const chats = await db.all(query)
    return chats
}

async function getMessages(phone, start, limit) {
    assert(typeof phone == 'string', 'handle must be a string')
    assert(typeof start == 'number', 'handle must be a number')
    assert(typeof limit == 'number', 'message must be a number')

    const db = await messagesDb.open()

    const query = `
    SELECT
        m.rowid as id,
        date as time, 
        id AS phoneNumber,
        m.guid as messageId,
        text as message,
        mime_type,
        filename,
        is_from_me as fromMe
    FROM message AS m
    LEFT JOIN message_attachment_join AS maj ON message_id = m.rowid
    LEFT JOIN attachment AS a ON a.rowid = maj.attachment_id
    LEFT JOIN handle AS h ON h.rowid = m.handle_id
    WHERE phoneNumber='+${phone}' OR phoneNumber='${phone}'
    ORDER BY m.ROWID
    DESC 
    LIMIT ${limit}
    OFFSET ${start}
`

    const messages = await db.all(query)

    return parseMessages(messages.reverse())
}

async function checkExists(phone) {
    const db = await messagesDb.open()

    const query = `
    SELECT * 
    FROM  "chat" 
    WHERE "guid" = 'iMessage;-;+${phone}' OR "guid" = 'iMessage;-;${phone}'
    ORDER BY 1 
    LIMIT 300 
    OFFSET 0;
    `

    const exists = await db.all(query)
    return exists
}

async function getMessageId(phone, text, sent = 1, fromMe = 1) {
    return new Promise(async res => {
        const query = `
            SELECT
                id AS phoneNumber,
                m.guid as messageId,
                text as message,
                is_from_me as fromMe,
                is_sent as sent
            FROM message AS m
            LEFT JOIN handle AS h ON h.rowid = m.handle_id
            WHERE phoneNumber='+${phone}' OR phoneNumber='${phone}'  AND message='${text}' AND sent=${sent} AND fromMe=${fromMe}
            ORDER BY m.ROWID
            DESC
            `

        const db = await messagesDb.open()

        let messages = []

        while (true) {
            messages = await db.all(query)
            if (messages.length) break

            await new Promise(res => setTimeout(res, 100))
        }

        res(parseMessages(messages)[0])
    })
}

module.exports = {
    send,
    listen,
    checkExists,
    sendFile,
    getMessages,
    handleForName,
    nameForHandle,
    getRecentChats,
    getMessageId,
    SUPPRESS_WARNINGS: false,
}
