import * as express from 'express'
import * as Promise from 'bluebird'

import { pseudoRandomBytesPromise } from './core-utils'
import { CONFIG, database as db } from '../initializers'
import { ResultList } from '../../shared'

function badRequest (req: express.Request, res: express.Response, next: express.NextFunction) {
  res.type('json').status(400).end()
}

function generateRandomString (size: number) {
  return pseudoRandomBytesPromise(size).then(raw => raw.toString('hex'))
}

interface FormatableToJSON {
  toFormatedJSON ()
}

function getFormatedObjects<U, T extends FormatableToJSON> (objects: T[], objectsTotal: number) {
  const formatedObjects: U[] = []

  objects.forEach(object => {
    formatedObjects.push(object.toFormatedJSON())
  })

  const res: ResultList<U> = {
    total: objectsTotal,
    data: formatedObjects
  }

  return res
}

function isSignupAllowed () {
  if (CONFIG.SIGNUP.ENABLED === false) {
    return Promise.resolve(false)
  }

  // No limit and signup is enabled
  if (CONFIG.SIGNUP.LIMIT === -1) {
    return Promise.resolve(true)
  }

  return db.User.countTotal().then(totalUsers => {
    return totalUsers < CONFIG.SIGNUP.LIMIT
  })
}

// ---------------------------------------------------------------------------

export {
  badRequest,
  generateRandomString,
  getFormatedObjects,
  isSignupAllowed
}
