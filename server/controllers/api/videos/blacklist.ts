import * as express from 'express'

import { database as db } from '../../../initializers/database'
import { logger } from '../../../helpers'
import {
  authenticate,
  ensureIsAdmin,
  videosBlacklistValidator
} from '../../../middlewares'

const blacklistRouter = express.Router()

blacklistRouter.post('/:id/blacklist',
  authenticate,
  ensureIsAdmin,
  videosBlacklistValidator,
  addVideoToBlacklist
)

// ---------------------------------------------------------------------------

export {
  blacklistRouter
}

// ---------------------------------------------------------------------------

function addVideoToBlacklist (req: express.Request, res: express.Response, next: express.NextFunction) {
  const videoInstance = res.locals.video

  const toCreate = {
    videoId: videoInstance.id
  }

  db.BlacklistedVideo.create(toCreate)
    .then(() => res.type('json').status(204).end())
    .catch(err => {
      logger.error('Errors when blacklisting video ', err)
      return next(err)
    })
}
