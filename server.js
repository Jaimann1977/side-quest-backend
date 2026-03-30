require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Firebase Admin Init ──────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: `${serviceAccount.project_id}.firebasestorage.app`
});

const db = admin.firestore();
const bucket = admin.storage().bucket();
const cardsCollection = db.collection('cards');

// ─── Multer: memory storage ───────────────────────────────────────────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max per file
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/jpg', 'image/png'];
        if (allowed.includes(file.mimetype.toLowerCase())) {
            cb(null, true);
        } else {
            cb(new Error('Only JPEG and PNG images are allowed'));
        }
    }
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
    : '*';

app.use(cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── POST /polish — polish description text with AI ──────────────────────────
app.post('/polish', async (req, res) => {
    try {
        const { description } = req.body;

        if (!description || !description.trim()) {
            return res.status(400).json({ error: 'Description is required' });
        }

        if (!process.env.GROQ_API_KEY) {
            return res.status(500).json({ error: 'AI service not configured' });
        }

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{
                    role: 'user',
                    content: `Polish this business/service description to be more professional, engaging, and compelling. Keep it concise (under 250 words). Maintain the original meaning and key details. Only return the polished description, no preamble or explanation.\n\nOriginal description:\n${description}`
                }],
                temperature: 0.7,
                max_tokens: 500
            })
        });

        if (!response.ok) {
            throw new Error(`Groq API error: ${response.status}`);
        }

        const data = await response.json();
        const polishedText = data.choices[0].message.content.trim();
        res.json({ polished: polishedText });

    } catch (err) {
        console.error('POST /polish error:', err);
        res.status(500).json({ error: 'Failed to polish description' });
    }
});

// ─── GET /cards — fetch all active (non-expired) cards ───────────────────────
app.get('/cards', async (req, res) => {
    try {
        const now = admin.firestore.Timestamp.now();

        const snapshot = await cardsCollection
            .where('expires_at', '>', now)
            .orderBy('expires_at', 'desc')
            .get();

        const cards = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            cards.push(formatCard(doc.id, data));
        });

        // Sort by created_at descending (newest first)
        cards.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json(cards);
    } catch (err) {
        console.error('GET /cards error:', err);
        res.status(500).json({ error: 'Failed to fetch cards' });
    }
});

// ─── POST /cards — submit a new card with images ──────────────────────────────
app.post('/cards', upload.fields([
    { name: 'coverImage', maxCount: 1 },
    { name: 'productImages', maxCount: 10 }
]), async (req, res) => {
    try {
        const { businessName, employeeName, webpageUrl, description } = req.body;

        if (!businessName || !employeeName || !description) {
            return res.status(400).json({ error: 'businessName, employeeName, and description are required' });
        }

        // Upload cover image if provided
        let coverImageUrl = null;
        if (req.files?.coverImage?.[0]) {
            coverImageUrl = await uploadImage(req.files.coverImage[0]);
        }

        // Upload product images if provided
        const productImageUrls = [];
        if (req.files?.productImages) {
            for (const file of req.files.productImages) {
                const url = await uploadImage(file);
                productImageUrls.push(url);
            }
        }

        const now = new Date();
        const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

        const cardData = {
            business_name: businessName,
            employee_name: employeeName,
            webpage_url: webpageUrl || null,
            description,
            cover_image_url: coverImageUrl,
            product_image_urls: productImageUrls,
            created_at: admin.firestore.Timestamp.fromDate(now),
            expires_at: admin.firestore.Timestamp.fromDate(expiresAt)
        };

        const docRef = await cardsCollection.add(cardData);

        res.status(201).json(formatCard(docRef.id, cardData));

    } catch (err) {
        console.error('POST /cards error:', err);
        res.status(500).json({ error: err.message || 'Failed to create card' });
    }
});

// ─── PUT /cards/:id — update an existing card ────────────────────────────────
app.put('/cards/:id', upload.fields([
    { name: 'coverImage', maxCount: 1 },
    { name: 'productImages', maxCount: 10 }
]), async (req, res) => {
    try {
        const { id } = req.params;
        const { businessName, employeeName, webpageUrl, description, existingCoverImage, existingProductImages } = req.body;

        console.log('=== PUT /cards/:id ===');
        console.log('Card ID:', id);

        if (!businessName || !employeeName || !description) {
            return res.status(400).json({ error: 'businessName, employeeName, and description are required' });
        }

        // Fetch existing card
        const docRef = cardsCollection.doc(id);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ error: 'Card not found' });
        }

        const existingCard = docSnap.data();
        console.log('Existing card found:', existingCard.business_name);

        // Handle cover image
        let coverImageUrl = existingCard.cover_image_url;

        if (req.files?.coverImage?.[0]) {
            // Delete old cover image
            if (existingCard.cover_image_url) {
                try {
                    await deleteImage(urlToStoragePath(existingCard.cover_image_url));
                } catch (err) {
                    console.error('Error deleting old cover image:', err);
                }
            }
            coverImageUrl = await uploadImage(req.files.coverImage[0]);
            console.log('New cover image uploaded:', coverImageUrl);
        } else if (existingCoverImage && existingCoverImage !== 'null' && existingCoverImage !== 'undefined') {
            coverImageUrl = existingCoverImage;
        }

        // Handle product images
        let productImageUrls = [];

        if (existingProductImages) {
            try {
                const parsed = JSON.parse(existingProductImages);
                productImageUrls = Array.isArray(parsed) ? parsed : [];
            } catch (e) {
                productImageUrls = [];
            }
        }

        // Upload new product images
        if (req.files?.productImages) {
            for (const file of req.files.productImages) {
                const url = await uploadImage(file);
                productImageUrls.push(url);
            }
        }

        // Delete removed product images from storage
        if (existingCard.product_image_urls?.length) {
            for (const oldUrl of existingCard.product_image_urls) {
                if (!productImageUrls.includes(oldUrl)) {
                    try {
                        await deleteImage(urlToStoragePath(oldUrl));
                    } catch (err) {
                        console.error('Error deleting removed product image:', err);
                    }
                }
            }
        }

        const updateData = {
            business_name: businessName,
            employee_name: employeeName,
            webpage_url: webpageUrl || null,
            description,
            cover_image_url: coverImageUrl,
            product_image_urls: productImageUrls
        };

        await docRef.update(updateData);
        console.log('Update successful');

        res.json(formatCard(id, { ...existingCard, ...updateData }));

    } catch (err) {
        console.error('PUT /cards/:id error:', err);
        res.status(500).json({ error: err.message || 'Failed to update card' });
    }
});

// ─── DELETE /cards/:id — remove a card and its images ────────────────────────
app.delete('/cards/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const docRef = cardsCollection.doc(id);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ error: 'Card not found' });
        }

        const card = docSnap.data();

        // Delete images from storage
        if (card.cover_image_url) {
            try { await deleteImage(urlToStoragePath(card.cover_image_url)); } catch (e) {}
        }
        if (card.product_image_urls?.length) {
            for (const url of card.product_image_urls) {
                try { await deleteImage(urlToStoragePath(url)); } catch (e) {}
            }
        }

        await docRef.delete();
        res.json({ success: true });

    } catch (err) {
        console.error('DELETE /cards/:id error:', err);
        res.status(500).json({ error: 'Failed to delete card' });
    }
});

// ─── DELETE /cards/cleanup/expired — cleanup expired cards ───────────────────
app.delete('/cards/cleanup/expired', async (req, res) => {
    try {
        const now = admin.firestore.Timestamp.now();

        const snapshot = await cardsCollection
            .where('expires_at', '<=', now)
            .get();

        let deletedCount = 0;
        for (const doc of snapshot.docs) {
            const card = doc.data();

            if (card.cover_image_url) {
                try { await deleteImage(urlToStoragePath(card.cover_image_url)); } catch (e) {}
            }
            if (card.product_image_urls?.length) {
                for (const url of card.product_image_urls) {
                    try { await deleteImage(urlToStoragePath(url)); } catch (e) {}
                }
            }

            await doc.ref.delete();
            deletedCount++;
        }

        res.json({ success: true, deleted: deletedCount });
    } catch (err) {
        console.error('Cleanup error:', err);
        res.status(500).json({ error: 'Cleanup failed' });
    }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Upload a file buffer to Firebase Storage and return the public URL
async function uploadImage(file) {
    const ext = file.mimetype === 'image/png' ? 'png' : 'jpg';
    const filename = `cards/${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${ext}`;
    const fileRef = bucket.file(filename);

    await fileRef.save(file.buffer, {
        contentType: file.mimetype,
        public: true
    });

    return `https://storage.googleapis.com/${bucket.name}/${filename}`;
}

// Extract the storage path from a Firebase Storage public URL
function urlToStoragePath(url) {
    // Public URLs look like: https://storage.googleapis.com/{bucket}/{path}
    const marker = `${bucket.name}/`;
    const idx = url.indexOf(marker);
    return idx !== -1 ? url.substring(idx + marker.length) : url;
}

// Delete a file from Firebase Storage
async function deleteImage(storagePath) {
    await bucket.file(storagePath).delete();
}

// Format a Firestore doc into the shape the frontend expects
function formatCard(id, data) {
    return {
        id,
        business_name: data.business_name,
        employee_name: data.employee_name,
        webpage_url: data.webpage_url || null,
        description: data.description,
        cover_image_url: data.cover_image_url || null,
        product_image_urls: data.product_image_urls || [],
        created_at: data.created_at?.toDate ? data.created_at.toDate().toISOString() : data.created_at,
        expires_at: data.expires_at?.toDate ? data.expires_at.toDate().toISOString() : data.expires_at
    };
}

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`Side Quest backend running on port ${PORT}`);
});
