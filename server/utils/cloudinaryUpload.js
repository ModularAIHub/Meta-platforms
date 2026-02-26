const cloudinary = require('cloudinary').v2;
const axios = require('axios');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function uploadUrlToCloudinary(sourceUrl, publicIdPrefix = 'threads') {
  const resp = await axios.get(sourceUrl, { responseType: 'arraybuffer', timeout: 15000 });
  const buffer = Buffer.from(resp.data);
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { resource_type: 'image', folder: `${publicIdPrefix}` },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    uploadStream.end(buffer);
  });
}

function isCloudinaryUrl(url) {
  return typeof url === 'string' && url.includes('res.cloudinary.com');
}

module.exports = { uploadUrlToCloudinary, isCloudinaryUrl };
