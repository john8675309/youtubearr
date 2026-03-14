// YouTube Search Web Server
// Install dependencies: npm install express youtube-search-without-api-key

const express = require('express');
const yt = require('youtube-search-without-api-key');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const NodeID3 = require('node-id3');
const { MusicBrainzApi } = require('musicbrainz-api');

// Initialize MusicBrainz API client
const mbApi = new MusicBrainzApi({
    appName: 'youtube-music-downloader',
    appVersion: '1.0.0',
    appContactInfo: 'https://github.com/yourusername/youtube-music-downloader'
});

const app = express();
const PORT = 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Directory for downloaded files
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR);
}

// Database file for albums
const DB_FILE = path.join(__dirname, 'albums.json');

// Settings file
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// Load or initialize albums database
let albumsDB = { albums: [] };
if (fs.existsSync(DB_FILE)) {
    try {
        albumsDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
        console.error('Error loading albums database:', err);
    }
}

// Load or initialize settings
let settings = { 
    outputDirectory: path.join(__dirname, 'downloads')
};
if (fs.existsSync(SETTINGS_FILE)) {
    try {
        const loadedSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        settings = { ...settings, ...loadedSettings };
    } catch (err) {
        console.error('Error loading settings:', err);
    }
}

// Save albums database
function saveAlbumsDB() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(albumsDB, null, 2));
    } catch (err) {
        console.error('Error saving albums database:', err);
    }
}

// Save settings
function saveSettings() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (err) {
        console.error('Error saving settings:', err);
    }
}

// Serve static files (HTML, CSS, JS)
app.use(express.static('public'));

// Settings Endpoints

// Get settings
app.get('/api/settings', (req, res) => {
    res.json({ success: true, settings });
});

// Update settings
app.post('/api/settings', (req, res) => {
    const { outputDirectory } = req.body;
    
    if (outputDirectory) {
        // Validate directory exists or can be created
        try {
            if (!fs.existsSync(outputDirectory)) {
                fs.mkdirSync(outputDirectory, { recursive: true });
            }
            settings.outputDirectory = outputDirectory;
            saveSettings();
            console.log('Output directory updated to:', outputDirectory);
        } catch (err) {
            return res.status(400).json({ 
                error: 'Invalid directory path',
                message: err.message 
            });
        }
    }
    
    res.json({ success: true, settings });
});

// Update yt-dlp
app.post('/api/update-ytdlp', (req, res) => {
    const ytDlpPath = path.join(__dirname, 'yt-dlp');
    
    // Check if yt-dlp exists
    if (!fs.existsSync(ytDlpPath)) {
        return res.status(404).json({ 
            error: 'yt-dlp not found',
            message: 'yt-dlp executable not found in server directory' 
        });
    }
    
    console.log('Updating yt-dlp...');
    
    // Run yt-dlp -U to update
    exec(`"${ytDlpPath}" -U`, (error, stdout, stderr) => {
        if (error) {
            console.error('yt-dlp update error:', error);
            console.error('stderr:', stderr);
            return res.status(500).json({ 
                error: 'Failed to update yt-dlp',
                message: stderr || error.message
            });
        }
        
        console.log('yt-dlp update output:', stdout);
        
        res.json({ 
            success: true, 
            message: 'yt-dlp updated successfully',
            output: stdout
        });
    });
});

// Album Management Endpoints

// Search and import album from MusicBrainz
app.post('/api/albums/import', async (req, res) => {
    try {
        const { artist, album } = req.body;
        
        if (!artist || !album) {
            return res.status(400).json({ error: 'Artist and album name are required' });
        }
        
        console.log(`Searching MusicBrainz for: ${artist} - ${album}`);
        
        // Search for release group (album)
        const searchResult = await mbApi.search('release-group', {
            query: `artist:"${artist}" AND releasegroup:"${album}"`,
            limit: 1
        });
        
        if (!searchResult['release-groups'] || searchResult['release-groups'].length === 0) {
            return res.status(404).json({ 
                error: 'Album not found on MusicBrainz',
                message: `Could not find "${album}" by ${artist}` 
            });
        }
        
        const releaseGroup = searchResult['release-groups'][0];
        
        // Get detailed release information with recordings
        const releaseSearchResult = await mbApi.search('release', {
            query: `rgid:${releaseGroup.id}`,
            limit: 1
        });
        
        if (!releaseSearchResult.releases || releaseSearchResult.releases.length === 0) {
            return res.status(404).json({ error: 'Could not find release details' });
        }
        
        const releaseId = releaseSearchResult.releases[0].id;
        
        // Lookup full release with recordings
        const releaseDetails = await mbApi.lookup('release', releaseId, ['recordings', 'artist-credits']);
        
        // Extract album info
        const albumTitle = releaseGroup.title;
        const artistName = releaseGroup['artist-credit'] ? 
            releaseGroup['artist-credit'].map(ac => ac.name).join(', ') : artist;
        const year = releaseGroup['first-release-date'] ? 
            new Date(releaseGroup['first-release-date']).getFullYear() : new Date().getFullYear();
        
        // Get cover art URL from Cover Art Archive
        let coverUrl = '';
        try {
            const coverArtUrl = `https://coverartarchive.org/release-group/${releaseGroup.id}/front-500`;
            coverUrl = coverArtUrl;
        } catch (err) {
            console.log('Cover art not available');
        }
        
        // Create the album
        const newAlbum = {
            id: Date.now().toString(),
            title: albumTitle,
            artist: artistName,
            year: year,
            genre: releaseGroup['primary-type'] || 'Unknown',
            coverUrl: coverUrl,
            tracks: [],
            createdAt: new Date().toISOString(),
            musicbrainzId: releaseGroup.id
        };
        
        // Add tracks from media
        if (releaseDetails.media && Array.isArray(releaseDetails.media)) {
            releaseDetails.media.forEach(media => {
                if (media.tracks) {
                    media.tracks.forEach(track => {
                        newAlbum.tracks.push({
                            id: `${newAlbum.id}_${track.position}`,
                            title: track.title || track.recording?.title || `Track ${track.position}`,
                            trackNumber: parseInt(track.position) || newAlbum.tracks.length + 1,
                            youtubeId: '',
                            downloaded: false,
                            filename: '',
                            musicbrainzId: track.recording?.id
                        });
                    });
                }
            });
        }
        
        // Save to database
        albumsDB.albums.push(newAlbum);
        saveAlbumsDB();
        
        console.log(`Imported album: ${albumTitle} with ${newAlbum.tracks.length} tracks`);
        
        res.json({ 
            success: true, 
            album: newAlbum,
            message: `Successfully imported "${albumTitle}" with ${newAlbum.tracks.length} tracks from MusicBrainz`
        });
        
    } catch (error) {
        console.error('Error importing album:', error);
        res.status(500).json({ 
            error: 'Failed to import album from MusicBrainz',
            message: error.message 
        });
    }
});

// Get all albums
app.get('/api/albums', (req, res) => {
    res.json(albumsDB);
});

// Create new album
app.post('/api/albums', (req, res) => {
    const { title, artist, year, genre, coverUrl } = req.body;
    
    if (!title || !artist) {
        return res.status(400).json({ error: 'Title and artist are required' });
    }
    
    const album = {
        id: Date.now().toString(),
        title,
        artist,
        year: year || new Date().getFullYear(),
        genre: genre || '',
        coverUrl: coverUrl || '',
        tracks: [],
        createdAt: new Date().toISOString()
    };
    
    albumsDB.albums.push(album);
    saveAlbumsDB();
    
    res.json({ success: true, album });
});

// Update album
app.put('/api/albums/:id', (req, res) => {
    const { id } = req.params;
    const { title, artist, year, genre, coverUrl } = req.body;
    
    const album = albumsDB.albums.find(a => a.id === id);
    if (!album) {
        return res.status(404).json({ error: 'Album not found' });
    }
    
    if (title) album.title = title;
    if (artist) album.artist = artist;
    if (year) album.year = year;
    if (genre !== undefined) album.genre = genre;
    if (coverUrl !== undefined) album.coverUrl = coverUrl;
    
    saveAlbumsDB();
    res.json({ success: true, album });
});

// Delete album
app.delete('/api/albums/:id', (req, res) => {
    const { id } = req.params;
    const index = albumsDB.albums.findIndex(a => a.id === id);
    
    if (index === -1) {
        return res.status(404).json({ error: 'Album not found' });
    }
    
    albumsDB.albums.splice(index, 1);
    saveAlbumsDB();
    
    res.json({ success: true });
});

// Add track to album
app.post('/api/albums/:id/tracks', (req, res) => {
    const { id } = req.params;
    const { title, trackNumber, youtubeId } = req.body;
    
    const album = albumsDB.albums.find(a => a.id === id);
    if (!album) {
        return res.status(404).json({ error: 'Album not found' });
    }
    
    if (!title) {
        return res.status(400).json({ error: 'Track title is required' });
    }
    
    const track = {
        id: Date.now().toString(),
        title,
        trackNumber: trackNumber || album.tracks.length + 1,
        youtubeId: youtubeId || '',
        downloaded: false,
        filename: ''
    };
    
    album.tracks.push(track);
    saveAlbumsDB();
    
    res.json({ success: true, track });
});

// Update track
app.put('/api/albums/:albumId/tracks/:trackId', (req, res) => {
    const { albumId, trackId } = req.params;
    const { title, trackNumber, youtubeId } = req.body;
    
    const album = albumsDB.albums.find(a => a.id === albumId);
    if (!album) {
        return res.status(404).json({ error: 'Album not found' });
    }
    
    const track = album.tracks.find(t => t.id === trackId);
    if (!track) {
        return res.status(404).json({ error: 'Track not found' });
    }
    
    if (title) track.title = title;
    if (trackNumber) track.trackNumber = trackNumber;
    if (youtubeId !== undefined) track.youtubeId = youtubeId;
    
    saveAlbumsDB();
    res.json({ success: true, track });
});

// Delete track
app.delete('/api/albums/:albumId/tracks/:trackId', (req, res) => {
    const { albumId, trackId } = req.params;
    
    const album = albumsDB.albums.find(a => a.id === albumId);
    if (!album) {
        return res.status(404).json({ error: 'Album not found' });
    }
    
    const index = album.tracks.findIndex(t => t.id === trackId);
    if (index === -1) {
        return res.status(404).json({ error: 'Track not found' });
    }
    
    album.tracks.splice(index, 1);
    saveAlbumsDB();
    
    res.json({ success: true });
});

// API endpoint for searching
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        const duration = req.query.duration; // optional: 'under', 'between', 'over'
        
        if (!query) {
            return res.status(400).json({ error: 'Search query is required' });
        }
        
        console.log(`Searching for: ${query}${duration ? ` (duration: ${duration})` : ''}`);
        
        const searchOptions = duration ? { duration } : undefined;
        const videos = await yt.search(query, searchOptions);
        
        // Format the response
        const results = videos.map(video => ({
            id: video.id?.videoId || video.id,
            title: video.title || video.snippet?.title,
            url: video.url,
            duration: video.duration_raw || video.snippet?.duration || 'N/A',
            publishedAt: video.snippet?.publishedAt || 'N/A',
            thumbnail: video.snippet?.thumbnails?.url || 
                      video.snippet?.thumbnails?.high?.url || 
                      video.snippet?.thumbnails?.default?.url ||
                      `https://i.ytimg.com/vi/${video.id?.videoId || video.id}/hqdefault.jpg`,
            views: video.views || 'N/A'
        }));
        
        res.json({ success: true, results, count: results.length });
        
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ 
            error: 'Failed to search YouTube', 
            message: error.message 
        });
    }
});

// API endpoint for downloading and converting to MP3
app.get('/api/download', async (req, res) => {
    try {
        const videoId = req.query.id;
        const albumId = req.query.albumId;
        const trackId = req.query.trackId;
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        if (!videoId) {
            return res.status(400).json({ error: 'Video ID is required' });
        }
        
        console.log(`Downloading and converting: ${videoUrl}`);
        
        // Find album and track if provided
        let album, track;
        if (albumId && trackId) {
            album = albumsDB.albums.find(a => a.id === albumId);
            if (album) {
                track = album.tracks.find(t => t.id === trackId);
            }
        }
        
        // Output filename pattern
        const outputPattern = path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s');
        
        // yt-dlp command to download and convert to MP3
        const ytDlpPath = path.join(__dirname, 'yt-dlp');
        const command = `"${ytDlpPath}" -x --audio-format mp3 --audio-quality 0 -o "${outputPattern}" "${videoUrl}"`;
        
        exec(command, async (error, stdout, stderr) => {
            if (error) {
                console.error('Download error:', error);
                console.error('stderr:', stderr);
                return res.status(500).json({ 
                    error: 'Failed to download video',
                    message: error.message,
                    details: stderr
                });
            }
            
            console.log('Download output:', stdout);
            
            // Find the downloaded file
            const files = fs.readdirSync(DOWNLOAD_DIR);
            const mp3Files = files.filter(f => f.endsWith('.mp3'));
            
            if (mp3Files.length === 0) {
                return res.status(500).json({ error: 'MP3 file not found after conversion' });
            }
            
            // Get the most recently created MP3 file
            const latestFile = mp3Files
                .map(f => ({ name: f, time: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtime }))
                .sort((a, b) => b.time - a.time)[0].name;
            
            const filePath = path.join(DOWNLOAD_DIR, latestFile);
            
            // If album and track info provided, write ID3 tags
            if (album && track) {
                try {
                    const tags = {
                        title: track.title,
                        artist: album.artist,
                        album: album.title,
                        year: album.year.toString(),
                        trackNumber: track.trackNumber.toString(),
                        genre: album.genre || 'Unknown'
                    };
                    
                    // Download and add cover image if available
                    if (album.coverUrl) {
                        try {
                            const https = require('https');
                            const coverPath = path.join(DOWNLOAD_DIR, `cover_${albumId}.jpg`);
                            
                            await new Promise((resolve, reject) => {
                                https.get(album.coverUrl, (response) => {
                                    if (response.statusCode === 200) {
                                        const file = fs.createWriteStream(coverPath);
                                        response.pipe(file);
                                        file.on('finish', () => {
                                            file.close();
                                            tags.image = coverPath;
                                            resolve();
                                        });
                                    } else {
                                        resolve(); // Continue without cover
                                    }
                                }).on('error', () => resolve()); // Continue without cover
                            });
                        } catch (err) {
                            console.error('Error downloading cover:', err);
                        }
                    }
                    
                    // Write ID3 tags
                    const success = NodeID3.write(tags, filePath);
                    console.log('ID3 tags written:', success);
                    
                    // Rename file to proper format: 01 Artist Name - Album Name [Year] - Song Name.mp3
                    const trackNum = String(track.trackNumber).padStart(2, '0');
                    const newFilename = `${trackNum} ${album.artist} - ${album.title} [${album.year}] - ${track.title}.mp3`;
                    // Remove invalid filename characters
                    const sanitizedFilename = newFilename.replace(/[<>:"/\\|?*]/g, '_');
                    const newFilePath = path.join(DOWNLOAD_DIR, sanitizedFilename);
                    
                    // Rename the file
                    fs.renameSync(filePath, newFilePath);
                    
                    // Create Artist/Album [Year] directory structure
                    const sanitizedArtist = album.artist.replace(/[<>:"/\\|?*]/g, '_');
                    const sanitizedAlbum = `${album.title} [${album.year}]`.replace(/[<>:"/\\|?*]/g, '_');
                    const artistDir = path.join(settings.outputDirectory, sanitizedArtist);
                    const albumDir = path.join(artistDir, sanitizedAlbum);
                    
                    // Create directories if they don't exist
                    if (!fs.existsSync(artistDir)) {
                        fs.mkdirSync(artistDir, { recursive: true });
                    }
                    if (!fs.existsSync(albumDir)) {
                        fs.mkdirSync(albumDir, { recursive: true });
                    }
                    
                    // Copy to output directory with Artist/Album structure
                    const outputPath = path.join(albumDir, sanitizedFilename);
                    fs.copyFileSync(newFilePath, outputPath);
                    console.log('File saved to:', outputPath);
                    
                    // Clean up temporary file
                    if (fs.existsSync(newFilePath)) {
                        fs.unlinkSync(newFilePath);
                        console.log('Temporary file cleaned up:', newFilePath);
                    }
                    
                    // Update track in database
                    track.downloaded = true;
                    track.filename = sanitizedFilename;
                    track.youtubeId = videoId;
                    saveAlbumsDB();
                    
                    // Clean up cover image
                    if (tags.image && fs.existsSync(tags.image)) {
                        fs.unlinkSync(tags.image);
                    }
                    
                    // Send success response with file location
                    res.json({ 
                        success: true, 
                        filename: sanitizedFilename,
                        path: outputPath,
                        message: `Saved to ${outputPath}`
                    });
                    return;
                } catch (tagError) {
                    console.error('Error writing ID3 tags:', tagError);
                }
            }
            
            // Send file for download
            res.download(filePath, latestFile, (err) => {
                if (err) {
                    console.error('Error sending file:', err);
                }
                // Optionally delete the file after sending
                // fs.unlinkSync(filePath);
            });
        });
        
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ 
            error: 'Failed to download video', 
            message: error.message 
        });
    }
});

// Serve downloaded files
app.use('/downloads', express.static(DOWNLOAD_DIR));

// Start server
app.listen(PORT, () => {
    console.log(`YouTube Search Server running at http://localhost:${PORT}`);
    console.log(`Open your browser and go to: http://localhost:${PORT}`);
});
