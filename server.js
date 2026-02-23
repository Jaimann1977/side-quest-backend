require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Multer: store uploads in memory before sending to Supabase
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

// Middleware
const allowedOrigins = process.env.FRONTEND_URL 
    ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
    : '*';

app.use(cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// ─── Health check ────────────────────────────────────────────────────────────
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
                    content: `Polish this business/service description to be more professional, engaging, and compelling. Keep it concise (under 250 words). Maintain the original meaning and key details. Only return the polished description, no preamble or explanation.

Original description:
${description}`
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
        const { data, error } = await supabase
            .from('cards')
            .select('*')
            .gt('expires_at', new Date().toISOString())
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('GET /cards error:', err);
        res.status(500).json({ error: 'Failed to fetch cards' });
    }
});

// ─── POST /cards — submit a new card with images ─────────────────────────────
app.post('/cards', upload.fields([
    { name: 'coverImage', maxCount: 1 },
    { name: 'productImages', maxCount: 10 }
]), async (req, res) => {
    try {
        const { businessName, employeeName, webpageUrl, description } = req.body;

        // Validate required fields
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

        // Insert card into database
        const { data, error } = await supabase
            .from('cards')
            .insert([{
                business_name: businessName,
                employee_name: employeeName,
                webpage_url: webpageUrl || null,
                description,
                cover_image_url: coverImageUrl,
                product_image_urls: productImageUrls
            }])
            .select()
            .single();

        if (error) throw error;
        res.status(201).json(data);

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

        // Validate required fields
        if (!businessName || !employeeName || !description) {
            return res.status(400).json({ error: 'businessName, employeeName, and description are required' });
        }

        // Fetch existing card
        const { data: existingCard, error: fetchError } = await supabase
            .from('cards')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchError) throw fetchError;
        if (!existingCard) return res.status(404).json({ error: 'Card not found' });

        // Handle cover image
        let coverImageUrl = existingCard.cover_image_url; // Default to current
        
        if (req.files?.coverImage?.[0]) {
            // User uploaded a NEW cover image
            // Delete old cover image if it exists
            if (existingCard.cover_image_url) {
                try {
                    await deleteImage(urlToStoragePath(existingCard.cover_image_url));
                } catch (err) {
                    console.error('Error deleting old cover image:', err);
                }
            }
            // Upload new cover image
            coverImageUrl = await uploadImage(req.files.coverImage[0]);
        } else if (existingCoverImage && existingCoverImage !== 'null' && existingCoverImage !== 'undefined') {
            // User explicitly wants to keep existing image (sent from frontend)
            coverImageUrl = existingCoverImage;
        }
        // else: keep the existing card's cover_image_url (already set above)

        // Handle product images
        let productImageUrls = [];
        
        // Parse existing product images
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

        // Delete product images that were removed
        if (existingCard.product_image_urls && Array.isArray(existingCard.product_image_urls)) {
            for (const oldUrl of existingCard.product_image_urls) {
                if (!productImageUrls.includes(oldUrl)) {
                    try {
                        await deleteImage(urlToStoragePath(oldUrl));
                    } catch (err) {
                        console.error('Error deleting old product image:', err);
                    }
                }
            }
        }

        // Update card in database
        const { data, error } = await supabase
            .from('cards')
            .update({
                business_name: businessName,
                employee_name: employeeName,
                webpage_url: webpageUrl || null,
                description,
                cover_image_url: coverImageUrl,
                product_image_urls: productImageUrls
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);

    } catch (err) {
        console.error('PUT /cards/:id error:', err);
        res.status(500).json({ error: err.message || 'Failed to update card' });
    }
});

// ─── DELETE /cards/:id — remove a card and its images ────────────────────────
app.delete('/cards/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Fetch card first to get image URLs for cleanup
        const { data: card, error: fetchError } = await supabase
            .from('cards')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchError) throw fetchError;
        if (!card) return res.status(404).json({ error: 'Card not found' });

        // Delete images from storage
        const imagesToDelete = [];
        if (card.cover_image_url) imagesToDelete.push(urlToStoragePath(card.cover_image_url));
        if (card.product_image_urls?.length) {
            card.product_image_urls.forEach(url => imagesToDelete.push(urlToStoragePath(url)));
        }

        if (imagesToDelete.length > 0) {
            await supabase.storage.from('side-quest-images').remove(imagesToDelete);
        }

        // Delete card from database
        const { error: deleteError } = await supabase
            .from('cards')
            .delete()
            .eq('id', id);

        if (deleteError) throw deleteError;
        res.json({ success: true });

    } catch (err) {
        console.error('DELETE /cards/:id error:', err);
        res.status(500).json({ error: 'Failed to delete card' });
    }
});

// ─── DELETE /cards/expired — cleanup expired cards (can be called by a cron) ─
app.delete('/cards/cleanup/expired', async (req, res) => {
    try {
        // Fetch expired cards to clean up their images too
        const { data: expired, error: fetchError } = await supabase
            .from('cards')
            .select('*')
            .lt('expires_at', new Date().toISOString());

        if (fetchError) throw fetchError;

        let deletedCount = 0;
        for (const card of expired) {
            const imagesToDelete = [];
            if (card.cover_image_url) imagesToDelete.push(urlToStoragePath(card.cover_image_url));
            card.product_image_urls?.forEach(url => imagesToDelete.push(urlToStoragePath(url)));
            if (imagesToDelete.length > 0) {
                await supabase.storage.from('side-quest-images').remove(imagesToDelete);
            }
            await supabase.from('cards').delete().eq('id', card.id);
            deletedCount++;
        }

        res.json({ success: true, deleted: deletedCount });
    } catch (err) {
        console.error('Cleanup error:', err);
        res.status(500).json({ error: 'Cleanup failed' });
    }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Upload a file buffer to Supabase Storage and return the public URL
async function uploadImage(file) {
    const ext = file.mimetype === 'image/png' ? 'png' : 'jpg';
    const filename = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${ext}`;

    const { error } = await supabase.storage
        .from('side-quest-images')
        .upload(filename, file.buffer, {
            contentType: file.mimetype,
            upsert: false
        });

    if (error) throw error;

    const { data } = supabase.storage
        .from('side-quest-images')
        .getPublicUrl(filename);

    return data.publicUrl;
}

// Extract the storage path from a full public URL
function urlToStoragePath(url) {
    // Public URLs look like: https://<project>.supabase.co/storage/v1/object/public/side-quest-images/<filename>
    const marker = '/side-quest-images/';
    const idx = url.indexOf(marker);
    return idx !== -1 ? url.substring(idx + marker.length) : url;
}

// Delete an image from Supabase Storage
async function deleteImage(storagePath) {
    const { error } = await supabase.storage
        .from('side-quest-images')
        .remove([storagePath]);
    
    if (error) throw error;
}

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`Side Quest backend running on port ${PORT}`);
});
