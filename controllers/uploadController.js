// controllers/uploadController.js
const cloudinary = require('cloudinary').v2;
const { v4: uuidv4 } = require('uuid');

// Configure Cloudinary with environment variables ONLY
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Upload payment receipt
exports.uploadReceipt = async (req, res, next) => {
  try {
    // Check if Cloudinary is configured
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      return res.status(500).json({ 
        message: 'Cloudinary configuration missing. Please contact support.' 
      });
    }

    console.log('Upload receipt request received, files:', req.files);
    console.log('User making request:', req.user._id);
    
    if (!req.files || !req.files.receipt) {
      return res.status(400).json({ message: 'No receipt file uploaded' });
    }

    const receiptFile = req.files.receipt;
    
    // Validate file type
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (!allowedMimeTypes.includes(receiptFile.mimetype)) {
      return res.status(400).json({ 
        message: 'Invalid file type. Please upload JPEG, PNG, JPG, or PDF files only.' 
      });
    }

    // Validate file size (5MB max)
    if (receiptFile.size > 5 * 1024 * 1024) {
      return res.status(400).json({ 
        message: 'File size too large. Maximum size is 5MB.' 
      });
    }

    // Generate unique filename with user reference
    const userId = req.user._id;
    const fileName = `receipt_${userId}_${uuidv4()}`;

    console.log('Uploading to Cloudinary:', fileName);

    // Upload to Cloudinary
    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'auto',
          folder: 'payment_receipts',
          public_id: fileName,
          allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
          transformation: [
            { quality: 'auto', fetch_format: 'auto' }
          ]
        },
        (error, result) => {
          if (error) {
            console.error('Cloudinary upload error:', error);
            reject(error);
          } else {
            console.log('Cloudinary upload success:', result.secure_url);
            resolve(result);
          }
        }
      );

      // Use the file buffer
      uploadStream.end(receiptFile.data);
    });

    res.json({ 
      message: 'Receipt uploaded successfully',
      url: uploadResult.secure_url,
      publicId: uploadResult.public_id
    });

  } catch (err) {
    console.error('Receipt upload error:', err);
    
    if (err.message && err.message.includes('File size too large')) {
      return res.status(400).json({ 
        message: 'File size too large. Maximum size is 5MB.' 
      });
    }
    
    if (err.message && err.message.includes('Upload preset')) {
      return res.status(500).json({ 
        message: 'Cloudinary configuration error. Please contact support.' 
      });
    }
    
    res.status(500).json({ 
      message: 'Failed to upload receipt. Please try again.' 
    });
  }
};

// Delete uploaded receipt (optional cleanup)
exports.deleteReceipt = async (req, res, next) => {
  try {
    const { publicId } = req.body;
    
    if (!publicId) {
      return res.status(400).json({ message: 'Public ID is required' });
    }

    const result = await cloudinary.uploader.destroy(publicId);
    
    if (result.result === 'ok') {
      res.json({ message: 'Receipt deleted successfully' });
    } else {
      res.status(404).json({ message: 'Receipt not found' });
    }
  } catch (err) {
    console.error('Delete receipt error:', err);
    res.status(500).json({ message: 'Failed to delete receipt' });
  }
};