import { database as db } from '../../../initializers/database'
import { logger } from '../../../helpers'
import { addVideoToFriends } from '../../../lib'
import { VideoInstance } from '../../../models'

function process (data: { videoUUID: string }) {
  return db.Video.loadByUUIDAndPopulateAuthorAndPodAndTags(data.videoUUID).then(video => {
    return video.transcodeVideofile().then(() => video)
  })
}

function onError (err: Error, jobId: number) {
  logger.error('Error when transcoding video file in job %d.', jobId, err)
  return Promise.resolve()
}

function onSuccess (jobId: number, video: VideoInstance) {
  logger.info('Job %d is a success.', jobId)

  video.toAddRemoteJSON().then(remoteVideo => {
    // Now we'll add the video's meta data to our friends
    return addVideoToFriends(remoteVideo, null)
  })
}

// ---------------------------------------------------------------------------

export {
  process,
  onError,
  onSuccess
}
