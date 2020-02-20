const sqlite = require('sqlite')
const dbPath = `${process.env.HOME}/Library/Messages/chat.db`
const OPEN_READONLY = 1

let db
async function open() {
    if (db && db.driver.open) {
        return db
    }
    db = await sqlite.open(dbPath, { mode: OPEN_READONLY })
    console.log('Database opened', dbPath)

    db.__all = db.all
    db.all = async function(query, ...args) {
        try {
            return await db.__all(query, ...args)
        } catch (err) {
            console.log('error when query', query)
            throw err
        }
    }

    return db
}

let isClosing
function cleanUp() {
    if (db && db.driver.open && !isClosing) {
        isClosing = true
        console.log('Database close', dbPath)

        db.close()
    }
}
process.on('exit', cleanUp)
process.on('uncaughtException', cleanUp)

module.exports = {
    open,
}
