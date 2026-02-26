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
 *
 * @param {string} sourceUrl  - Any public https:// image URL (LinkedIn CDN, Twitter CDN, etc.)
 * @param {string} publicIdPrefix - Cloudinary folder name (default: 'threads')
 * @returns {Promise<object>} Cloudinary upload result with .secure_url
 */
async function uploadUrlToCloudinary(sourceUrl, publicIdPrefix = 'threads') {
  const resp = await axios.get(sourceUrl, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: {
      // Some CDNs (LinkedIn) block non-browser agents — spoof a browser UA
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
        // Force JPEG — Meta/Threads rejects webp and auto-format URLs
        format: 'jpg',
        transformation: [{ quality: 'auto:good' }],
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

export { uploadUrlToCloudinary, isCloudinaryUrl };