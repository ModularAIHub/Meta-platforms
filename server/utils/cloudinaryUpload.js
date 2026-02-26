import { v2 as cloudinary } from 'cloudinary';
import axios from 'axios';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Downloads an image from sourceUrl and uploads it to Cloudinary.
 * Forces JPEG output so Meta/Threads never receives a webp URL.
 */
async function uploadUrlToCloudinary(sourceUrl, publicIdPrefix = 'threads') {
  const resp = await axios.get(sourceUrl, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'image/jpeg,image/png,image/gif,image/*,*/*;q=0.8',
    },
  });

  const buffer = Buffer.from(resp.data);

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'image',
        folder: publicIdPrefix,
        format: 'jpg',
        transformation: [{ quality: 'auto:good' }],
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    uploadStream.end(buffer);
  });
}

/**
 * Uploads a raw Buffer directly to Cloudinary — NO disk writes.
 * Safe for serverless / read-only filesystem environments (Render, Railway, Vercel).
 * Used by internalThreads.js when cross-post media arrives as a data: URL (base64).
 *
 * @param {Buffer} buffer    - Image or video buffer already in memory
 * @param {string} mimetype  - e.g. 'image/jpeg', 'image/png', 'video/mp4'
 * @param {string} folder    - Cloudinary folder (default: 'threads')
 * @returns {Promise<object>} Cloudinary upload result with .secure_url
 */
async function uploadBufferToCloudinary(buffer, mimetype = 'image/jpeg', folder = 'threads') {
  const isVideo = String(mimetype).startsWith('video/');

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: isVideo ? 'video' : 'image',
        folder,
        ...(isVideo
          ? {}
          : {
              format: 'jpg',
              transformation: [{ quality: 'auto:good' }],
            }),
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    uploadStream.end(buffer);
  });
}

/**
 * Returns true if the URL is already hosted on Cloudinary.
 */
function isCloudinaryUrl(url) {
  return typeof url === 'string' && url.includes('res.cloudinary.com');
}

export { uploadUrlToCloudinary, uploadBufferToCloudinary, isCloudinaryUrl };