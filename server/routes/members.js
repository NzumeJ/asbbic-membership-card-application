const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const Member = require('../models/Member');
const { ensureAuthenticated } = require('../middleware/auth');

// Ensure directories exist
const uploadsDir = path.join(__dirname, '../../public/uploads');
const qrDir = path.join(__dirname, '../../public/qrcodes');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });

// Multer configuration
const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, "member-" + unique + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: function(req, file, cb) {
        const filetypes = /jpeg|jpg|png|gif/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Error: Images only (JPEG, JPG, PNG, GIF)'));
        }
    }
});

// Error handling middleware for multer
const multerErrorHandler = (err, req, res, next) => {
    if (err) {
        console.error('Multer error:', err);
        return res.status(400).json({
            success: false,
            message: err.message || 'Error uploading file'
        });
    }
    next();
};

// Test route to check if API is working
router.get('/test', (req, res) => {
    console.log('Test route hit');
    res.json({ success: true, message: 'API is working' });
});

// =========================
// CREATE NEW MEMBER (Public endpoint - no authentication required)
// =========================
router.post("/", upload.single("photo"), multerErrorHandler, async (req, res) => {
    console.log('POST /api/members - Request received');
    console.log('Request body:', req.body);
    console.log('Uploaded file:', req.file);

    try {
        const { fullName, email, phone, birthDate, birthPlace, activity, idNumber } = req.body;

        // Basic validation
        if (!fullName || !email || !phone) {
            console.log('Validation failed - missing required fields');
            // Clean up uploaded file if validation fails
            if (req.file) {
                fs.unlinkSync(req.file.path);
                console.log('Deleted uploaded file due to validation error');
            }
            return res.apiError("Full name, email and phone are required", 400);
        }

        // Duplicate email check
        const exists = await Member.findOne({ email });
        if (exists) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.apiError("A member with this email already exists", 400);
        }

        // Create new member
        const member = new Member({
            fullName,
            email,
            phone,
            birthDate: birthDate || null,
            birthPlace: birthPlace || null,
            activity: activity || null,
            idNumber: idNumber || null,
            status: "pending",
            memberId: "MEM" + Date.now().toString().slice(-6),
            photo: req.file ? "/uploads/" + req.file.filename : null
        });

        // Generate unique QR
        try {
            const qrValue = (process.env.BASE_URL || "http://localhost:3000") + "/verify/" + member._id;
            const qrFilePath = path.join(qrDir, `${member._id}.png`);
            await QRCode.toFile(qrFilePath, qrValue);
            member.qrCode = "/qrcodes/" + member._id + ".png";
        } catch (qrError) {
            console.error('Error generating QR code:', qrError);
            // Don't fail the request if QR code generation fails
            member.qrCode = null;
        }

        console.log('Saving member to database:', member);
        await member.save();
        console.log('Member saved successfully');

        // Use the API success helper
        return res.apiSuccess(member, 'Member created successfully', 201);

    } catch (err) {
        console.error('Error saving member:', err);
        // Clean up uploaded file if there's an error
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
            console.log('Deleted uploaded file due to error');
        }
        return res.apiError('Failed to create member', 500, err);
    }
});

// =========================
// GET ALL MEMBERS (Protected - requires authentication)
// =========================
router.get("/", ensureAuthenticated, async (req, res) => {
    console.log('GET /api/members - Fetching members');
    
    try {
        const { draw, start, length, search, order, columns } = req.query;
        const searchValue = search?.value || '';
        const page = start ? parseInt(start) / parseInt(length) + 1 : 1;
        const limit = length ? parseInt(length) : 10;
        const skip = start ? parseInt(start) : 0;
        
        // Handle sorting
        let sort = { createdAt: -1 }; // Default sort
        if (order && order[0] && columns) {
            const sortColumn = columns[order[0].column]?.data || 'createdAt';
            sort = { [sortColumn]: order[0].dir === 'asc' ? 1 : -1 };
        }

        // Build search query
        const query = {};
        if (searchValue) {
            query.$or = [
                { fullName: { $regex: searchValue, $options: 'i' } },
                { email: { $regex: searchValue, $options: 'i' } },
                { phone: { $regex: searchValue, $options: 'i' } },
                { idNumber: { $regex: searchValue, $options: 'i' } }
            ];
        }

        // Check if this is a DataTables request
        if (draw) {
            // Get counts and data in parallel for DataTables
            const [totalRecords, filteredRecords, members] = await Promise.all([
                Member.countDocuments(),
                Member.countDocuments(query),
                Member.find(query)
                    .sort(sort)
                    .skip(skip)
                    .limit(limit)
                    .lean()
            ]);

            // Format response for DataTables
            const data = members.map(member => ({
                _id: member._id,
                fullName: member.fullName || 'N/A',
                email: member.email || 'N/A',
                phone: member.phone || 'N/A',
                idNumber: member.idNumber || 'N/A',
                activity: member.activity || 'N/A',
                status: member.status || 'pending',
                createdAt: member.createdAt,
                actions: `
                    <a href="/admin/members/${member._id}" class="btn btn-sm btn-info">
                        <i class="fas fa-eye"></i> View
                    </a>
                    <button class="btn btn-sm btn-danger delete-member" data-id="${member._id}">
                        <i class="fas fa-trash"></i> Delete
                    </button>
                `
            }));

            return res.json({
                draw: parseInt(draw),
                recordsTotal: totalRecords,
                recordsFiltered: filteredRecords,
                data: data
            });
        } else {
            // Handle regular API request (non-DataTables)
            const members = await Member.find(query)
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .lean();
                
            return res.json({
                success: true,
                count: members.length,
                members
            });
        }
    } catch (err) {
        console.error('Error fetching members:', err);
        res.status(500).json({
            success: false,
            message: "Server error: " + err.message
        });
    }
});

// =========================
// TEST ROUTE: GET ALL MEMBERS (For debugging)
// =========================
router.get('/test/all', async (req, res) => {
    try {
        const members = await Member.find({}).sort({ createdAt: -1 });
        console.log('All members from DB:', members);
        return res.json({
            success: true,
            count: members.length,
            members
        });
    } catch (err) {
        console.error('Error fetching all members:', err);
        return res.status(500).json({
            success: false,
            message: 'Error fetching members'
        });
    }
});

// =========================
// GET ONE MEMBER
// =========================
router.get("/:id", ensureAuthenticated, async (req, res) => {
    try {
        const member = await Member.findById(req.params.id).lean();

        if (!member) {
            return res.status(404).json({
                success: false,
                message: "Member not found"
            });
        }

        // Ensure all required fields are present with defaults
        const memberData = {
            _id: member._id,
            fullName: member.fullName || 'N/A',
            email: member.email || 'N/A',
            phone: member.phone || 'N/A',
            photo: member.photo || '/images/default-avatar.png',
            status: member.status || 'pending',
            memberId: member.memberId || 'N/A',
            birthDate: member.birthDate || null,
            birthPlace: member.birthPlace || 'N/A',
            activity: member.activity || 'N/A',
            approvedAt: member.approvedAt || null,
            createdAt: member.createdAt,
            updatedAt: member.updatedAt
        };

        res.json({
            success: true,
            member: memberData
        });

    } catch (err) {
        console.error('Error fetching member:', err);
        return res.status(500).json({
            success: false,
            message: "Server error: " + (process.env.NODE_ENV === 'development' ? err.message : 'An error occurred')
        });
    }
});

// =========================
// DELETE MEMBER
// =========================
router.delete("/:id", ensureAuthenticated, async (req, res) => {
    try {
        const member = await Member.findByIdAndDelete(req.params.id);
        
        if (!member) {
            return res.status(404).json({
                success: false,
                message: "Member not found"
            });
        }

        // If there's a photo, delete it from the filesystem
        if (member.photo) {
            const filePath = path.join(__dirname, '../../public', member.photo);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }

        return res.json({
            success: true,
            message: "Member deleted successfully"
        });

    } catch (err) {
        console.error('Error deleting member:', err);
        return res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});

// =========================
// DOWNLOAD MEMBER PHOTO
// =========================
router.get("/:id/photo", ensureAuthenticated, async (req, res) => {
    try {
        const member = await Member.findById(req.params.id);
        
        if (!member || !member.photo) {
            return res.status(404).json({
                success: false,
                message: "Member or photo not found"
            });
        }

        // Get the file extension from the photo path
        const fileExt = path.extname(member.photo).toLowerCase();
        const fileName = `${member.fullName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}${fileExt}`;
        const filePath = path.join(__dirname, '../../public', member.photo);

        // Check if file exists
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({
                success: false,
                message: "Photo file not found"
            });
        }

        // Set headers for file download
        res.download(filePath, fileName, (err) => {
            if (err) {
                console.error('Error downloading file:', err);
                if (!res.headersSent) {
                    res.status(500).json({
                        success: false,
                        message: "Error downloading photo"
                    });
                }
            }
        });

    } catch (err) {
        console.error('Error in photo download:', err);
        return res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});

// =========================
// UPDATE MEMBER STATUS
// =========================
router.patch("/:id/status", ensureAuthenticated, async (req, res) => {
    try {
        const { status } = req.body;
        
        if (!['pending', 'approved', 'rejected'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: "Invalid status. Must be 'pending', 'approved', or 'rejected'"
            });
        }

        const member = await Member.findByIdAndUpdate(
            req.params.id,
            { status },
            { new: true, runValidators: true }
        );

        if (!member) {
            return res.status(404).json({
                success: false,
                message: "Member not found"
            });
        }

        return res.json({
            success: true,
            message: `Member ${status} successfully`,
            member
        });

    } catch (err) {
        console.error('Error updating member status:', err);
        return res.status(500).json({
            success: false,
            message: "Server error: " + err.message
        });
    }
});

// =========================
// DELETE MEMBER
// =========================
router.delete("/:id", ensureAuthenticated, async (req, res) => {
    try {
        const member = await Member.findByIdAndDelete(req.params.id);

        if (!member) {
            return res.status(404).json({
                success: false,
                message: "Member not found"
            });
        }

        if (member.photo) {
            const p = path.join(__dirname, '../../public', member.photo);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }

        if (member.qrCode) {
            const q = path.join(__dirname, '../../public', member.qrCode);
            if (fs.existsSync(q)) fs.unlinkSync(q);
        }

        return res.json({
            success: true,
            message: "Member deleted successfully"
        });

    } catch {
        return res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});

module.exports = router;
