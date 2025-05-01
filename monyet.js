const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Ganti dengan token bot Telegram Anda.
// Lebih aman menggunakan environment variable.
// Di Termux/proot-distro, jalankan: export BOT_TOKEN='YOUR_BOT_TOKEN_HERE' sebelum menjalankan script
const token = 'YOUR_BOT_TOKEN_HERE';

// Pastikan BOT_TOKEN sudah diset
if (!token) {
    console.error('Error: BOT_TOKEN environment variable is not set.');
    console.error('Please set it using: export BOT_TOKEN=\'YOUR_BOT_TOKEN_HERE\'');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// Folder untuk menyimpan hasil download sementara
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const MAX_FILE_SIZE_MB = 50; // Batas ukuran file Telegram untuk bot (50MB)

// Buat folder download jika belum ada
if (!fs.existsSync(DOWNLOAD_DIR)){
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

console.log('Bot Telegram YouTube Downloader sedang berjalan...');

// Listener untuk command /start
bot.onText(/^\/start (.+) (mp3|mp4)$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const youtubeUrl = match[1];
    const format = match[2].toLowerCase(); // mp3 atau mp4
    const messageIdToDelete = msg.message_id; // <--- Ambil ID pesan pengguna
    console.log(`Menerima command /start dari user ${msg.from.username || msg.from.first_name} (${chatId})`);
    console.log(`URL: ${youtubeUrl}, Format: ${format}`);
    // === Tambahkan kode ini: Hapus pesan perintah pengguna ===
    bot.deleteMessage(chatId, messageIdToDelete)
       .then(() => {
           console.log(`Pesan command /start ${messageIdToDelete} dari chat ${chatId} berhasil dihapus.`);
       })
       .catch((error) => {
           // Logging error jika gagal menghapus, tapi bot tetap mengirim pesan selamat datang
           console.error(`Gagal menghapus pesan command /start ${messageIdToDelete} di chat ${chatId}:`, error);
       });
    // Validasi sederhana URL (bisa diperbaiki)
    if (!youtubeUrl.includes('youtube.com/') && !youtubeUrl.includes('youtu.be/')) {
        bot.sendMessage(chatId, 'Format perintah salah atau URL tidak valid. Gunakan:\n`/start <url_youtube> mp3`\natau\n`/start <url_youtube> mp4`\n\nContoh:\n`/start https://www.youtube.com/watch?v=dQw4w9WgXcQ mp4`\n`/start https://www.youtube.com/playlist?list=PL... mp3`', { parse_mode: 'Markdown' });
        return;
    }

    let messageId; // Untuk menyimpan ID pesan "sedang mendownload" agar bisa di-edit
    try {
        const loadingMessage = await bot.sendMessage(chatId, `⏳ Sedang memproses dan mendownload...\nURL: \`${youtubeUrl}\`\nFormat: \`${format.toUpperCase()}\``, { parse_mode: 'Markdown' });
        messageId = loadingMessage.message_id;

        let ytDlpCommand;
        const outputTemplate = path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s'); // Simpan di folder downloads

        if (format === 'mp4') {
            // yt-dlp command untuk MP4: pilih video terbaik + audio terbaik dan gabungkan, atau fallback ke best mp4
            ytDlpCommand = `yt-dlp -f 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]' --merge-output-format mp4 -o "${outputTemplate}" "${youtubeUrl}" --print after_move:filepath`;
        } else if (format === 'mp3') {
            // yt-dlp command untuk MP3: ekstrak audio, konversi ke mp3, kualitas terbaik
             ytDlpCommand = `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${outputTemplate}" "${youtubeUrl}" --print after_move:filepath`;
        } else {
             bot.editMessageText('Format tidak didukung. Gunakan `mp3` atau `mp4`.', { chat_id: chatId, message_id: messageId });
             return;
        }

        console.log(`Menjalankan command: ${ytDlpCommand}`);

        exec(ytDlpCommand, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => { // Tingkatkan maxBuffer untuk output panjang (misal playlist)
            if (error) {
                console.error(`Error yt-dlp: ${error.message}`);
                console.error(`yt-dlp stderr: ${stderr}`);
                bot.editMessageText(`❌ Gagal mendownload.\n\nDetail Error:\n\`\`\`\n${stderr.substring(0, 500)}\n\`\`\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                // Coba hapus file jika ada yang terdownload sebagian dan gagal
                fs.readdir(DOWNLOAD_DIR, (err, files) => {
                     if (err) console.error('Gagal membaca direktori download:', err);
                     else {
                         files.forEach(file => {
                             const filePath = path.join(DOWNLOAD_DIR, file);
                             fs.unlink(filePath, unlinkErr => {
                                 if (unlinkErr) console.error(`Gagal menghapus file ${filePath}:`, unlinkErr);
                                 else console.log(`File sementara ${filePath} dihapus.`);
                             });
                         });
                     }
                 });

                return;
            }

            console.log(`yt-dlp stdout:\n${stdout}`);
            // Output dari --print after_move:filepath adalah path file per baris
            const downloadedFiles = stdout.trim().split('\n').filter(filePath => filePath.length > 0);

            if (downloadedFiles.length === 0) {
                 bot.editMessageText('❌ Gagal mendownload: Tidak ada file yang dihasilkan.', { chat_id: chatId, message_id: messageId });
                 return;
            }

// Asumsi ini adalah setelah proses download selesai
bot.editMessageText(`✅ Download selesai. Mengirim ${downloadedFiles.length} file...`, { chat_id: chatId, message_id: messageId })
    .then(() => {
        // Pesan berhasil diedit. Sekarang langsung panggil fungsi untuk menghapus pesan ini.
        bot.deleteMessage(chatId, messageId)
            .then(() => {
                console.log(`Pesan ${messageId} di chat ${chatId} berhasil dihapus segera setelah diedit.`);
            })
            .catch((error) => {
                console.error(`Gagal menghapus pesan ${messageId} di chat ${chatId}:`, error);
            });
    })
    .catch((error) => {
        console.error("Gagal mengedit pesan:", error);
    });

            // Kirim file satu per satu
            downloadedFiles.forEach(filePath => {
                fs.stat(filePath, (err, stats) => {
                    if (err) {
                        console.error(`Gagal mendapatkan info file ${filePath}:`, err);
                        bot.sendMessage(chatId, `❌ Gagal mengirim file ${path.basename(filePath)}: File tidak ditemukan atau error info.`);
                         // Tetap coba hapus file yang tidak bisa di stat
                         fs.unlink(filePath, unlinkErr => {
                              if (unlinkErr) console.error(`Gagal menghapus file ${filePath}:`, unlinkErr);
                              else console.log(`File tidak terkirim ${filePath} dihapus.`);
                         });
                        return;
                    }

                    const fileSizeMB = stats.size / (1024 * 1024);

                    if (fileSizeMB > MAX_FILE_SIZE_MB) {
                        const sizeMsg = `⚠️ File "${path.basename(filePath)}" (${fileSizeMB.toFixed(2)}MB) terlalu besar untuk dikirim via bot (maks ${MAX_FILE_SIZE_MB}MB). File tetap tersimpan di server.`;
                        bot.sendMessage(chatId, sizeMsg);
                        console.warn(sizeMsg);
                        // Tidak menghapus file karena user diberitahu bahwa file tersimpan di server
                    } else {
                        // Kirim file
                        console.log(`Mengirim file: ${filePath} (${fileSizeMB.toFixed(2)}MB)`);

                         // Gunakan sendDocument agar bisa mengirim MP3/MP4
                        bot.sendDocument(chatId, filePath)
                            .then(() => {
                                console.log(`File ${filePath} berhasil dikirim.`);
                                // Hapus file setelah berhasil dikirim
                                fs.unlink(filePath, unlinkErr => {
                                    if (unlinkErr) console.error(`Gagal menghapus file ${filePath} setelah dikirim:`, unlinkErr);
                                    else console.log(`File terkirim ${filePath} dihapus.`);
                                });
                            })
                            .catch(sendError => {
                                console.error(`Gagal mengirim file ${filePath}:`, sendError);
                                bot.sendMessage(chatId, `❌ Gagal mengirim file "${path.basename(filePath)}".`);
                                // Hapus file meskipun gagal dikirim untuk menghindari penumpukan
                                fs.unlink(filePath, unlinkErr => {
                                    if (unlinkErr) console.error(`Gagal menghapus file ${filePath} setelah gagal dikirim:`, unlinkErr);
                                    else console.log(`File gagal terkirim ${filePath} dihapus.`);
                                });
                            });
                    }
                });
            });
        });

    } catch (err) {
        console.error('Unexpected error:', err);
        if (messageId) {
             bot.editMessageText('❌ Terjadi error tak terduga saat memproses permintaan Anda.', { chat_id: chatId, message_id: messageId });
        } else {
            bot.sendMessage(chatId, '❌ Terjadi error tak terduga saat memproses permintaan Anda.');
        }
    }
});

// Pesan selamat datang atau info bot
bot.onText(/^\/start$/, (msg) => {
     const chatId = msg.chat.id;
    const messageIdToDelete = msg.message_id; // <--- Ambil ID pesan pengguna

    // === Tambahkan kode ini: Hapus pesan perintah pengguna ===
    bot.deleteMessage(chatId, messageIdToDelete)
       .then(() => {
           console.log(`Pesan command /start ${messageIdToDelete} dari chat ${chatId} berhasil dihapus.`);
       })
       .catch((error) => {
           // Logging error jika gagal menghapus, tapi bot tetap mengirim pesan selamat datang
           console.error(`Gagal menghapus pesan command /start ${messageIdToDelete} di chat ${chatId}:`, error);
       });
    bot.sendMessage(chatId, 'Selamat datang di Bot YouTube Downloader!\n\nUntuk mendownload video atau playlist, gunakan perintah:\n`/start <url_youtube> mp3`\natau\n`/start <url_youtube> mp4`\n\nContoh:\n`/start https://www.youtube.com/watch?v=dQw4w9WgXcQ mp4`\n`/start https://www.youtube.com/playlist?list=PL... mp3`', { parse_mode: 'Markdown' });
});


// Error handling umum polling
bot.on('polling_error', (error) => {
  console.error(`Polling error: ${error.code} - ${error.message}`);
});
