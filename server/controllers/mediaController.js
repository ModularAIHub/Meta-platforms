import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';
import multer from 'multer';

// ── Cloudinary config ────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Multer — memory storage only (no disk writes) ────────────────────────────
const fileFilter = (_req, file, cb) => {
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime.startsWith('image/') || mime.startsWith('video/')) {
    return cb(null, true);
  }
  return cb(new Error('Only image/video uploads are supported'));
};

export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: {
    fileSize: Number.parseInt(process.env.MAX_FILE_SIZE || '104857600', 10), // 100MB default
  },
});

// ── Upload buffer to Cloudinary ───────────────────────────────────────────────
const uploadToCloudinary = (buffer, mimetype, originalName) => {
  return new Promise((resolve, reject) => {
    const isVideo = mimetype.startsWith('video/');

    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: isVideo ? 'video' : 'image',
        folder: 'suitegenie/social-genie',
        use_filename: true,
        unique_filename: true,
        overwrite: false,
        // Auto-optimize images for web delivery
        ...(isVideo ? {} : {
          transformation: [
            { quality: 'auto', fetch_format: 'auto' }
          ]
        }),
      },
      (error, result) => {
        if (error) {
          console.error('[CLOUDINARY] Upload error:', error);
          return reject(error);
        }
        resolve(result);
      }
    );

    Readable.from(buffer).pipe(stream);
  });
};

// ── POST /api/media/upload ────────────────────────────────────────────────────
export const uploadMedia = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'File is required' });
  }

  // Validate Cloudinary is configured
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.error('[CLOUDINARY] Missing environment variables: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET');
    return res.status(500).json({
      error: 'Media storage is not configured',
      code: 'CLOUDINARY_NOT_CONFIGURED',
    });
  }

  try {
    console.log('[CLOUDINARY] Uploading file:', {
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    });

    const result = await uploadToCloudinary(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname
    );

    console.log('[CLOUDINARY] Upload success:', {
      publicId: result.public_id,
      url: result.secure_url,
      format: result.format,
      bytes: result.bytes,
    });

    return res.json({
      success: true,
      url: result.secure_url,          // full https:// URL — Meta can fetch this directly
      publicId: result.public_id,
      originalName: req.file.originalname,
      size: result.bytes,
      mimetype: req.file.mimetype,
      width: result.width || null,
      height: result.height || null,
      format: result.format || null,
    });
  } catch (error) {
    console.error('[CLOUDINARY] Upload failed:', error?.message || error);
    return res.status(500).json({
      error: 'Failed to upload media',
      code: 'MEDIA_UPLOAD_FAILED',
      details: error?.message || 'Unknown error',
    });
  }
};