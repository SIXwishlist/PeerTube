import * as express from 'express'
import * as Promise from 'bluebird'
import * as multer from 'multer'
import * as path from 'path'

import { database as db } from '../../../initializers/database'
import {
  CONFIG,
  REQUEST_VIDEO_QADU_TYPES,
  REQUEST_VIDEO_EVENT_TYPES,
  VIDEO_CATEGORIES,
  VIDEO_LICENCES,
  VIDEO_LANGUAGES
} from '../../../initializers'
import {
  addEventToRemoteVideo,
  quickAndDirtyUpdateVideoToFriends,
  addVideoToFriends,
  updateVideoToFriends
} from '../../../lib'
import {
  authenticate,
  paginationValidator,
  videosSortValidator,
  setVideosSort,
  setPagination,
  setVideosSearch,
  videosUpdateValidator,
  videosSearchValidator,
  videosAddValidator,
  videosGetValidator,
  videosRemoveValidator
} from '../../../middlewares'
import {
  logger,
  retryTransactionWrapper,
  generateRandomString,
  getFormatedObjects,
  renamePromise
} from '../../../helpers'
import { TagInstance } from '../../../models'
import { VideoCreate, VideoUpdate } from '../../../../shared'

import { abuseVideoRouter } from './abuse'
import { blacklistRouter } from './blacklist'
import { rateVideoRouter } from './rate'

const videosRouter = express.Router()

// multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, CONFIG.STORAGE.VIDEOS_DIR)
  },

  filename: (req, file, cb) => {
    let extension = ''
    if (file.mimetype === 'video/webm') extension = 'webm'
    else if (file.mimetype === 'video/mp4') extension = 'mp4'
    else if (file.mimetype === 'video/ogg') extension = 'ogv'
    generateRandomString(16)
      .then(randomString => {
        const filename = randomString
        cb(null, filename + '.' + extension)
      })
      .catch(err => {
        logger.error('Cannot generate random string for file name.', err)
        throw err
      })
  }
})

const reqFiles = multer({ storage: storage }).fields([{ name: 'videofile', maxCount: 1 }])

videosRouter.use('/', abuseVideoRouter)
videosRouter.use('/', blacklistRouter)
videosRouter.use('/', rateVideoRouter)

videosRouter.get('/categories', listVideoCategories)
videosRouter.get('/licences', listVideoLicences)
videosRouter.get('/languages', listVideoLanguages)

videosRouter.get('/',
  paginationValidator,
  videosSortValidator,
  setVideosSort,
  setPagination,
  listVideos
)
videosRouter.put('/:id',
  authenticate,
  videosUpdateValidator,
  updateVideoRetryWrapper
)
videosRouter.post('/',
  authenticate,
  reqFiles,
  videosAddValidator,
  addVideoRetryWrapper
)
videosRouter.get('/:id',
  videosGetValidator,
  getVideo
)

videosRouter.delete('/:id',
  authenticate,
  videosRemoveValidator,
  removeVideo
)

videosRouter.get('/search/:value',
  videosSearchValidator,
  paginationValidator,
  videosSortValidator,
  setVideosSort,
  setPagination,
  setVideosSearch,
  searchVideos
)

// ---------------------------------------------------------------------------

export {
  videosRouter
}

// ---------------------------------------------------------------------------

function listVideoCategories (req: express.Request, res: express.Response, next: express.NextFunction) {
  res.json(VIDEO_CATEGORIES)
}

function listVideoLicences (req: express.Request, res: express.Response, next: express.NextFunction) {
  res.json(VIDEO_LICENCES)
}

function listVideoLanguages (req: express.Request, res: express.Response, next: express.NextFunction) {
  res.json(VIDEO_LANGUAGES)
}

// Wrapper to video add that retry the function if there is a database error
// We need this because we run the transaction in SERIALIZABLE isolation that can fail
function addVideoRetryWrapper (req: express.Request, res: express.Response, next: express.NextFunction) {
  const options = {
    arguments: [ req, res, req.files.videofile[0] ],
    errorMessage: 'Cannot insert the video with many retries.'
  }

  retryTransactionWrapper(addVideo, options)
    .then(() => {
      // TODO : include Location of the new video -> 201
      res.type('json').status(204).end()
    })
    .catch(err => next(err))
}

function addVideo (req: express.Request, res: express.Response, videoFile: Express.Multer.File) {
  const videoInfos: VideoCreate = req.body

  return db.sequelize.transaction(t => {
    const user = res.locals.oauth.token.User

    const name = user.username
    // null because it is OUR pod
    const podId = null
    const userId = user.id

    return db.Author.findOrCreateAuthor(name, podId, userId, t)
      .then(author => {
        const tags = videoInfos.tags
        if (!tags) return { author, tagInstances: undefined }

        return db.Tag.findOrCreateTags(tags, t).then(tagInstances => ({ author, tagInstances }))
      })
      .then(({ author, tagInstances }) => {
        const videoData = {
          name: videoInfos.name,
          remote: false,
          extname: path.extname(videoFile.filename),
          category: videoInfos.category,
          licence: videoInfos.licence,
          language: videoInfos.language,
          nsfw: videoInfos.nsfw,
          description: videoInfos.description,
          duration: videoFile['duration'], // duration was added by a previous middleware
          authorId: author.id
        }

        const video = db.Video.build(videoData)
        return { author, tagInstances, video }
      })
      .then(({ author, tagInstances, video }) => {
        const videoDir = CONFIG.STORAGE.VIDEOS_DIR
        const source = path.join(videoDir, videoFile.filename)
        const destination = path.join(videoDir, video.getVideoFilename())

        return renamePromise(source, destination)
          .then(() => {
            // This is important in case if there is another attempt in the retry process
            videoFile.filename = video.getVideoFilename()
            return { author, tagInstances, video }
          })
      })
      .then(({ author, tagInstances, video }) => {
        const options = { transaction: t }

        return video.save(options)
          .then(videoCreated => {
            // Do not forget to add Author informations to the created video
            videoCreated.Author = author

            return { tagInstances, video: videoCreated }
          })
      })
      .then(({ tagInstances, video }) => {
        if (!tagInstances) return video

        const options = { transaction: t }
        return video.setTags(tagInstances, options)
          .then(() => {
            video.Tags = tagInstances
            return video
          })
      })
      .then(video => {
        // Let transcoding job send the video to friends because the videofile extension might change
        if (CONFIG.TRANSCODING.ENABLED === true) return undefined

        return video.toAddRemoteJSON()
          .then(remoteVideo => {
            // Now we'll add the video's meta data to our friends
            return addVideoToFriends(remoteVideo, t)
          })
      })
  })
  .then(() => logger.info('Video with name %s created.', videoInfos.name))
  .catch((err: Error) => {
    logger.debug('Cannot insert the video.', { error: err.stack })
    throw err
  })
}

function updateVideoRetryWrapper (req: express.Request, res: express.Response, next: express.NextFunction) {
  const options = {
    arguments: [ req, res ],
    errorMessage: 'Cannot update the video with many retries.'
  }

  retryTransactionWrapper(updateVideo, options)
    .then(() => {
      // TODO : include Location of the new video -> 201
      return res.type('json').status(204).end()
    })
    .catch(err => next(err))
}

function updateVideo (req: express.Request, res: express.Response) {
  const videoInstance = res.locals.video
  const videoFieldsSave = videoInstance.toJSON()
  const videoInfosToUpdate: VideoUpdate = req.body

  return db.sequelize.transaction(t => {
    let tagsPromise: Promise<TagInstance[]>
    if (!videoInfosToUpdate.tags) {
      tagsPromise = Promise.resolve(null)
    } else {
      tagsPromise = db.Tag.findOrCreateTags(videoInfosToUpdate.tags, t)
    }

    return tagsPromise
      .then(tagInstances => {
        const options = {
          transaction: t
        }

        if (videoInfosToUpdate.name !== undefined) videoInstance.set('name', videoInfosToUpdate.name)
        if (videoInfosToUpdate.category !== undefined) videoInstance.set('category', videoInfosToUpdate.category)
        if (videoInfosToUpdate.licence !== undefined) videoInstance.set('licence', videoInfosToUpdate.licence)
        if (videoInfosToUpdate.language !== undefined) videoInstance.set('language', videoInfosToUpdate.language)
        if (videoInfosToUpdate.nsfw !== undefined) videoInstance.set('nsfw', videoInfosToUpdate.nsfw)
        if (videoInfosToUpdate.description !== undefined) videoInstance.set('description', videoInfosToUpdate.description)

        return videoInstance.save(options).then(() => tagInstances)
      })
      .then(tagInstances => {
        if (!tagInstances) return

        const options = { transaction: t }
        return videoInstance.setTags(tagInstances, options)
          .then(() => {
            videoInstance.Tags = tagInstances

            return
          })
      })
      .then(() => {
        const json = videoInstance.toUpdateRemoteJSON()

        // Now we'll update the video's meta data to our friends
        return updateVideoToFriends(json, t)
      })
  })
  .then(() => {
    logger.info('Video with name %s updated.', videoInstance.name)
  })
  .catch(err => {
    logger.debug('Cannot update the video.', err)

    // Force fields we want to update
    // If the transaction is retried, sequelize will think the object has not changed
    // So it will skip the SQL request, even if the last one was ROLLBACKed!
    Object.keys(videoFieldsSave).forEach(key => {
      const value = videoFieldsSave[key]
      videoInstance.set(key, value)
    })

    throw err
  })
}

function getVideo (req: express.Request, res: express.Response, next: express.NextFunction) {
  const videoInstance = res.locals.video

  if (videoInstance.isOwned()) {
    // The increment is done directly in the database, not using the instance value
    videoInstance.increment('views')
      .then(() => {
        // FIXME: make a real view system
        // For example, only add a view when a user watch a video during 30s etc
        const qaduParams = {
          videoId: videoInstance.id,
          type: REQUEST_VIDEO_QADU_TYPES.VIEWS
        }
        return quickAndDirtyUpdateVideoToFriends(qaduParams)
      })
      .catch(err => logger.error('Cannot add view to video %d.', videoInstance.id, err))
  } else {
    // Just send the event to our friends
    const eventParams = {
      videoId: videoInstance.id,
      type: REQUEST_VIDEO_EVENT_TYPES.VIEWS
    }
    addEventToRemoteVideo(eventParams)
  }

  // Do not wait the view system
  res.json(videoInstance.toFormatedJSON())
}

function listVideos (req: express.Request, res: express.Response, next: express.NextFunction) {
  db.Video.listForApi(req.query.start, req.query.count, req.query.sort)
    .then(result => res.json(getFormatedObjects(result.data, result.total)))
    .catch(err => next(err))
}

function removeVideo (req: express.Request, res: express.Response, next: express.NextFunction) {
  const videoInstance = res.locals.video

  videoInstance.destroy()
    .then(() => res.type('json').status(204).end())
    .catch(err => {
      logger.error('Errors when removed the video.', err)
      return next(err)
    })
}

function searchVideos (req: express.Request, res: express.Response, next: express.NextFunction) {
  db.Video.searchAndPopulateAuthorAndPodAndTags(req.params.value, req.query.field, req.query.start, req.query.count, req.query.sort)
    .then(result => res.json(getFormatedObjects(result.data, result.total)))
    .catch(err => next(err))
}
