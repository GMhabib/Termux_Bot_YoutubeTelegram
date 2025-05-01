// Import library yang diperlukan
const { Telegraf } = require('telegraf');
const { spawn, exec } = require('child_process'); // Menggunakan spawn untuk stream output, exec untuk ffmpeg
const fs = require('fs').promises; // Untuk menghapus file sementara
const path = require('path'); // Untuk menangani jalur file
const { URL } = require('url'); // Untuk validasi URL dasar

// --- Konfigurasi Bot ---
// GANTI dengan token bot Anda
const BOT_TOKEN = 'YOUR_BOT_TOKEN_HERE'; // <-- Pastikan ini token yang benar
const telek = new Telegraf(BOT_TOKEN);
const YT_DLP_PATH = 'yt-dlp'; // Contoh: '/usr/local/bin/yt-dlp' atau 'yt-dlp.exe' di Windows
const FFMPEG_PATH = 'ffmpeg'; // Contoh: '/usr/local/bin/ffmpeg' atau 'ffmpeg.exe' di Windows
// Direktori sementara untuk menyimpan file yang didownload sebelum dikirim
const TEMP_DIR = path.join(__dirname, 'temp_downloads'); // Akan membuat folder 'temp_downloads'

// --- Batas Ukuran Upload Telegram (50 MB) ---
const TELEGRAM_FILE_LIMIT_BYTES = 50 * 1024 * 1024; // 50 MB dalam byte

// --- State untuk Mengelola Proses Download dan Progres ---
const activeDownloads = new Map(); // Menyimpan proses spawn berdasarkan chatId
const progressMessages = new Map(); // Menyimpan { chatId: messageId } untuk pesan progres
const lastReportedProgress = new Map(); // Menyimpan { chatId: lastPercentage } untuk menghindari spam edit
// State tambahan untuk menyimpan judul per chat ID
const videoTitles = new Map();

// Pastikan direktori sementara ada saat bot dimulai
fs.mkdir(TEMP_DIR, { recursive: true }).catch(console.error);

// --- Handler Perintah /start ---
telek.start(async (eek) => {
    const chatId = eek.chat.id;
    const messageId = eek.message.message_id; // Ambil ID pesan pengguna
    const args = eek.message.text.split(' ');
    const youtubeUrl = args[1]; // Argumen kedua adalah URL
    const formatArg = args[2] ? args[2].toLowerCase() : null; // Argumen ketiga adalah format (mp3/mp4)

    // --- Validasi Input ---
    if (!youtubeUrl || !formatArg) {
        // Jika argumen tidak lengkap, kirim pesan panduan penggunaan
        return eek.reply(
            '🙋‍♂ Selamat Datang 💁‍♀\n\n' +
            'Gunakan perintah dengan format:\n' +
            `/start [URL_YOUTUBE] [mp3/mp4]\n\n` +
            'Contoh:\n' +
            '`/start https://www.youtube.com/watch?v=dQw4w9WgXcQ mp4`\n' + // Video tunggal
             '`/start https://music.youtube.com/watch?v=XYZ mp3`\n' + // YouTube Music
             '`/start https://youtube.com/shorts/ABC mp4`\n' + // YouTube Shorts
             '`/start https://www.youtube.com/playlist?list=... mp4`\n' + // Playlist (biasanya hanya mendownload video pertama)
            '*Pastikan URL lengkap dengan `http://` atau `https://`.\n' +
            '*Format harus ditulis persis: `mp3` atau `mp4`.\n' +
            '*Dukungan playlist terbatas, umumnya hanya memproses item pertama.'
        );
    }

    // Validasi format yang diminta
    if (formatArg !== 'mp3' && formatArg !== 'mp4') {
        return eek.reply('Format tidak valid. Pilih `mp3` atau `mp4`.');
    }

    // Validasi URL dasar menggunakan object URL
    try {
        new URL(youtubeUrl); // Akan throw error jika URL tidak valid
    } catch (e) {
        return eek.reply('URL YouTube tidak valid. Mohon periksa kembali.');
    }

    // Periksa apakah ada download yang sedang berjalan untuk chat ini
    if (activeDownloads.has(chatId)) {
        return eek.reply('⏳ Ada proses download yang sedang berjalan. Silakan tunggu hingga selesai atau gunakan /stop untuk menghentikannya.');
    }

    // --- Hapus pesan perintah pengguna setelah semua validasi berhasil ---
    try {
        await telek.telegram.deleteMessage(chatId, messageId);
        console.log(`Deleted user command message ${messageId} in chat ${chatId}`);
    } catch (deleteError) {
        console.error(`Failed to delete user command message ${messageId} in chat ${chatId}:`, deleteError.message);
        // Lanjutkan proses meskipun gagal menghapus pesan
    }


    // --- Mulai Proses Download ---
    // Beri tahu pengguna bahwa proses sedang berjalan dan simpan ID pesan untuk diedit
    const processingMessage = await eek.reply(`⏳ Memulai proses download ${formatArg.toUpperCase()}...\n\`${youtubeUrl}\`\n\nProses: 0%`);
    const processingMessageId = processingMessage.message_id;
    progressMessages.set(chatId, processingMessageId);
    lastReportedProgress.set(chatId, 0); // Inisialisasi progres terakhir
    videoTitles.delete(chatId); // Bersihkan judul sebelumnya

    // Tentukan path output sementara
    // %(id)s mengambil ID unik video YouTube, %(ext)s mengambil ekstensi final (mp4 atau mp3)
    const outputTemplate = path.join(TEMP_DIR, '%(id)s.%(ext)s');

    // Susun argumen yt-dlp untuk ukuran file terkecil (tetap menggunakan format terkecil)
    const ytDlpArgs = [];

    if (formatArg === 'mp4') {
        // Argumen untuk MP4 ukuran terkecil (resolusi rendah)
        ytDlpArgs.push(
            '-f', 'bestvideo[height<=360][ext=mp4]+bestaudio[abr<=128]/best[height<=360]/best', // Mengambil 360p jika ada
            '--merge-output-format', 'mp4'
        );
    } else { // formatArg === 'mp3'
        // Argumen untuk MP3 ukuran terkecil (bitrate rendah)
        ytDlpArgs.push(
            '-x', // Extract audio
            '--audio-format', 'mp3',
            '--audio-quality', '9' // Kualitas terendah (0-9, 0 terbaik)
        );
    }

    // Argumen umum
    ytDlpArgs.push(
        '-O', '%(title)s', // CETAK JUDUL KE STDOUT
        '--restrict-filenames', // Hindari karakter aneh di nama file
        '-o', outputTemplate, // Tentukan output path
        '--print', 'after_move:filepath', // CETAK JALUR FILE FINAL SETELAH DOWNLOAD/KONVERSI KE STDOUT
        youtubeUrl // URL Target
    );

    console.log(`Executing yt-dlp for chat ${chatId} with args: ${ytDlpArgs.join(' ')}`);

    // Jalankan perintah yt-dlp menggunakan spawn
    const downloadProcess = spawn(YT_DLP_PATH, ytDlpArgs, { shell: false }); // shell: false lebih aman
    activeDownloads.set(chatId, downloadProcess);

    let stderrBuffer = ''; // Buffer untuk menampung output stderr parsial
    let stdoutBuffer = ''; // Buffer untuk menampung output stdout parsial
    let finalFilePath = null; // Untuk menyimpan jalur file akhir dari stdout
    let capturedTitle = null; // Untuk menyimpan judul dari stdout


    // Tangani output stderr (untuk progres)
    downloadProcess.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
        const lines = stderrBuffer.split(/\r?\n/); // Pecah berdasarkan newline
        stderrBuffer = lines.pop(); // Sisakan baris terakhir yang mungkin belum lengkap

        for (const line of lines) {
            // console.log(`[stderr] ${line}`); // Debug: lihat output stderr
            const progressMatch = line.match(/\[download\]\s+([\d.]+)% of/); // Diperbaiki regex agar lebih spesifik
            if (progressMatch && progressMatch[1]) {
                const currentProgress = parseFloat(progressMatch[1]);
                const lastProgress = lastReportedProgress.get(chatId) || 0;

                // Update pesan jika progres berubah signifikan (>5%) atau mendekati 100%
                // Atau jika progres masih di bawah 10% tapi ada update
                if (currentProgress - lastProgress >= 5 || currentProgress === 100 || (currentProgress < 10 && currentProgress > lastProgress)) {
                    const messageId = progressMessages.get(chatId);
                    if (messageId) {
                         eek.telegram.editMessageText(
                             chatId,
                             messageId,
                             null, // inlineMessageId, biarkan null
                             `⏳ Downloading ${formatArg.toUpperCase()}: ${currentProgress.toFixed(1)}%...\n\`${youtubeUrl}\``,
                             { parse_mode: 'Markdown' }
                         ).then(() => {
                             lastReportedProgress.set(chatId, currentProgress);
                         }).catch(editError => {
                            // console.error(`Failed to edit message ${messageId} for chat ${chatId}:`, editError.message);
                            // Hapus ID pesan dari map jika gagal mengedit (mungkin pesan sudah terhapus)
                            // progressMessages.delete(chatId); // Jangan dihapus, coba edit lagi nanti
                         });
                    }
                }
            } else if (line.includes('[ExtractAudio]')) {
                 // Update pesan saat proses ekstraksi audio dimulai
                 const messageId = progressMessages.get(chatId);
                 if (messageId && !lastReportedProgress.get(chatId).toString().includes('Extracting')) { // Hindari spam
                     eek.telegram.editMessageText(
                         chatId,
                         messageId,
                         null,
                         `⏳ Extracting Audio...\n\`${youtubeUrl}\``,
                         { parse_mode: 'Markdown' }
                     ).then(() => {
                          lastReportedProgress.set(chatId, 'Extracting'); // Tandai state
                     }).catch(editError => {
                         // console.error(`Failed to edit message (extracting) ${messageId} for chat ${chatId}:`, editError.message);
                     });
                 }
            } else if (line.includes('[Merger]')) {
                 // Update pesan saat proses penggabungan video/audio dimulai
                 const messageId = progressMessages.get(chatId);
                 if (messageId && !lastReportedProgress.get(chatId).toString().includes('Merging')) { // Hindari spam
                      eek.telegram.editMessageText(
                          chatId,
                          messageId,
                          null,
                          `⏳ Merging Video and Audio...\n\`${youtubeUrl}\``,
                          { parse_mode: 'Markdown' }
                      ).then(() => {
                           lastReportedProgress.set(chatId, 'Merging'); // Tandai state
                      }).catch(editError => {
                          // console.error(`Failed to edit message (merging) ${messageId} for chat ${chatId}:`, editError.message);
                      });
                 }
            }
        }
    });

     // Tangani output stdout (untuk judul dan jalur file final)
     downloadProcess.stdout.on('data', (data) => {
        stdoutBuffer += data.toString();
         const lines = stdoutBuffer.split(/\r?\n/);
         stdoutBuffer = lines.pop(); // Sisakan baris terakhir

         for (const line of lines) {
             // console.log(`[stdout] ${line}`); // Debug: lihat output stdout

             // Tangkap judul (biasanya baris pertama non-kosong dari -O %(title)s)
             if (!capturedTitle && line.trim() !== '') {
                 capturedTitle = line.trim();
                 videoTitles.set(chatId, capturedTitle); // Simpan judul per chat ID
                 console.log(`Captured title for chat ${chatId}: "${capturedTitle}"`);
             }

             // Deteksi jalur file final yang dicetak oleh '--print after_move:filepath'
             // Pastikan baris dimulai dengan direktori sementara
             if (line.startsWith(TEMP_DIR) && (line.endsWith('.mp4') || line.endsWith('.mp3'))) {
                 finalFilePath = line;
                 console.log(`Detected final file path for chat ${chatId} from stdout: ${finalFilePath}`);
                 // Tidak perlu break, mungkin ada output lain
             }
         }
     });


    downloadProcess.on('error', (error) => {
        console.error(`Failed to start yt-dlp process for chat ${chatId}:`, error);
        // Cleanup state
        activeDownloads.delete(chatId);
        videoTitles.delete(chatId);
        const messageId = progressMessages.get(chatId);
        if (messageId) {
            eek.telegram.deleteMessage(chatId, messageId).catch(console.error);
            progressMessages.delete(chatId);
            lastReportedProgress.delete(chatId);
        }
        eek.reply(`❌ Gagal memulai proses yt-dlp: ${error.message}`);
    });


    downloadProcess.on('close', async (code) => {
        // Ambil judul yang sudah disimpan (jika ada)
        const titleToSend = videoTitles.get(chatId) || 'Tidak ada judul';

        // Ambil ID pesan progres sebelum dihapus
        const progressMsgId = progressMessages.get(chatId);

        // Cleanup state terlepas dari hasilnya
        activeDownloads.delete(chatId);
        videoTitles.delete(chatId);
        if (progressMsgId) {
            // Coba hapus pesan progres, abaikan error jika gagal
            eek.telegram.deleteMessage(chatId, progressMsgId).catch(console.error);
            progressMessages.delete(chatId);
            lastReportedProgress.delete(chatId);
        }


        // Cek apakah proses berhasil dan file final ada
        if (code !== 0 || !finalFilePath || !(await fs.access(finalFilePath).then(() => true).catch(() => false))) {
            console.error(`yt-dlp process exited with code ${code} for chat ${chatId}`);
            console.error(`Final file path detected (on close): ${finalFilePath}`);
            console.error(`File existence check (on close): ${await fs.access(finalFilePath).then(() => true).catch(() => false) ? 'Exists' : 'Does not exist'}`);

            let errorMessage = `❌ Gagal mendownload atau memproses video/audio "${titleToSend}". Kode keluar: ${code}. File tidak ditemukan atau tidak dapat diakses.`;

             // Coba bersihkan file parsial jika ada berdasarkan jalur final yang terdeteksi
             if (finalFilePath && finalFilePath.startsWith(TEMP_DIR)) {
                 fs.unlink(finalFilePath).catch((err) => {
                     if (err.code !== 'ENOENT') { // Abaikan error jika file tidak ada (sudah dihapus)
                          console.error(`Failed to clean up partial file ${finalFilePath}:`, err);
                     } else {
                         console.log(`Partial file ${finalFilePath} not found for cleanup.`);
                     }
                 });
             }
            await eek.reply(errorMessage);
            return;
        }

        // --- File Berhasil Didownload, Coba Kompresi (Khusus MP4) atau Kirim MP3 ---
        if (formatArg === 'mp4') {
            const compressedFilePath = finalFilePath.replace('.mp4', '_compressed.mp4');
            // Mengompresi ke setengah resolusi asli (jika ganjil, dibulatkan ke bawah) dan CRF 28 (kualitas lebih rendah, ukuran lebih kecil)
             // Menambahkan -maxrate dan -bufsize untuk kontrol bitrate (opsional tapi bisa bantu kurangi ukuran)
             // Menggunakan preset veryfast untuk kompresi lebih cepat (ukuran sedikit lebih besar dari medium/slow tapi signifikan)
            const compressCommand = `${FFMPEG_PATH} -i "${finalFilePath}" -vf 'scale=trunc(iw/2)*2:trunc(ih/2)*2' -crf 28 -preset veryfast -c:a copy "${compressedFilePath}"`;

            console.log(`Executing compression command for chat ${chatId}: ${compressCommand}`);

            const compressingMessage = await eek.reply('⏳ Mengompresi video (MP4)...'); // Pesan baru untuk proses kompresi

            // Gunakan exec untuk kompresi
            exec(compressCommand, { maxBuffer: 1024 * 1024 * 20 }, async (compressError, compressStdout, compressStderr) => { // Tingkatkan maxBuffer
                 await eek.telegram.deleteMessage(chatId, compressingMessage.message_id).catch(console.error); // Hapus pesan kompresi

                // --- Cek ukuran file terkompresi ---
                let fileToSendPath = compressedFilePath;
                let fileToSendName = `${titleToSend}_compressed.mp4`;
                let caption = `📽️ ${titleToSend} (Compressed MP4)\n🔗 ${youtubeUrl}`;
                let originalFileSizeMB = null; // Untuk menyimpan ukuran asli jika kompresi gagal

                 try {
                     const stats = await fs.stat(compressedFilePath);
                     const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                     console.log(`Compressed file size for chat ${chatId}: ${fileSizeMB} MB`);

                     if (stats.size > TELEGRAM_FILE_LIMIT_BYTES) {
                         await eek.reply(`❌ Video terkompresi "${titleToSend}" (${fileSizeMB} MB) melebihi batas ukuran Telegram (50 MB).`);
                         // Coba cek ukuran file asli jika kompresi gagal dan file asli ada
                          if (compressError && await fs.access(finalFilePath).then(() => true).catch(() => false)) {
                                const originalStats = await fs.stat(finalFilePath);
                                originalFileSizeMB = (originalStats.size / (1024 * 1024)).toFixed(2);
                                await eek.reply(`Ukuran file asli: ${originalFileSizeMB} MB.`);
                          }

                     } else if (!compressError) {
                          // Kompresi berhasil dan ukuran dalam batas
                          // await eek.reply(`✅ Kompresi berhasil (${fileSizeMB} MB). Mengirim file...`); // Opsional
                          await eek.replyWithDocument(
                              { source: fileToSendPath, filename: fileToSendName },
                              { caption: caption }
                          );
                     } else {
                         // Kompresi gagal, tapi file terkompresi mungkin ada tapi korup/kecil?
                         console.error(`FFmpeg compression error for chat ${chatId}:`, compressError);
                         console.error('FFmpeg Stderr:', compressStderr);
                         await eek.reply(`❌ Gagal mengompresi video "${titleToSend}".`);
                         // Lanjut ke mencoba mengirim file asli jika kompresi gagal
                          await handleSendOriginalMp4(chatId, finalFilePath, youtubeUrl, titleToSend, eek);
                          // Set fileToSendPath ke null agar cleanup di luar try/catch tidak menghapus compressedFilePath
                         fileToSendPath = null;

                     }
                 } catch (fileCheckOrSendError) {
                      console.error(`Error during file check, sending compressed file, or handling original file for chat ${chatId}:`, fileCheckOrSendError);
                      await eek.reply(`❌ Terjadi kesalahan saat memproses atau mengirim file video.`);
                      // Jika terjadi error di sini, pastikan file asli juga ditangani (misal jika kompresi gagal)
                       if (!compressError) { // Jika kompresi *dianggap* berhasil tapi ada error lain
                            await handleSendOriginalMp4(chatId, finalFilePath, youtubeUrl, titleToSend, eek);
                             fileToSendPath = null; // Set ke null untuk mencegah hapus compressedFilePath
                       }
                 } finally {
                      // Cleanup file
                      if (finalFilePath && finalFilePath.startsWith(TEMP_DIR)) {
                          fs.unlink(finalFilePath).catch((err) => {
                              if (err.code !== 'ENOENT') console.error(`Failed to clean original file ${finalFilePath}:`, err);
                          });
                      }
                       // Hapus file terkompresi hanya jika berhasil dibuat (fileToSendPath masih menunjuk ke compressedFilePath)
                      if (fileToSendPath && fileToSendPath.startsWith(TEMP_DIR)) {
                           fs.unlink(fileToSendPath).catch((err) => {
                               if (err.code !== 'ENOENT') console.error(`Failed to clean compressed file ${fileToSendPath}:`, err);
                           });
                       }
                 }

             });
        } else { // MP3 - Tidak ada kompresi tambahan saat ini, langsung cek ukuran dan kirim
            const fileToSendPath = finalFilePath; // File yang akan dikirim adalah file final hasil yt-dlp
            const fileToSendName = `${titleToSend}.mp3`;
            const caption = `🎵 ${titleToSend} (MP3)\n🔗 ${youtubeUrl}`;

             try {
                 const stats = await fs.stat(fileToSendPath);
                 const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                 console.log(`MP3 file size for chat ${chatId}: ${fileSizeMB} MB`);

                 if (stats.size > TELEGRAM_FILE_LIMIT_BYTES) {
                     await eek.reply(`❌ File audio "${titleToSend}" (${fileSizeMB} MB) melebihi batas ukuran Telegram (50 MB).`);
                 } else {
                      // Ukuran dalam batas, kirim
                     // await eek.reply(`✅ Download berhasil (${fileSizeMB} MB). Mengirim file...`); // Opsional
                     await eek.replyWithDocument(
                          { source: fileToSendPath, filename: fileToSendName },
                          { caption: caption }
                     );
                 }
             } catch (fileCheckOrSendError) {
                  console.error(`Error during file check or sending MP3 file for chat ${chatId}:`, fileCheckOrSendError);
                  await eek.reply(`❌ Gagal mengirim file audio melalui Telegram.`);
             } finally {
                 // Cleanup file
                 if (fileToSendPath && fileToSendPath.startsWith(TEMP_DIR)) {
                     fs.unlink(fileToSendPath).catch((err) => {
                         if (err.code !== 'ENOENT') console.error(`Failed to clean MP3 file ${fileToSendPath}:`, err);
                     });
                 }
             }
        }
    });
});

// Helper function to handle sending original MP4 if compression fails
async function handleSendOriginalMp4(chatId, originalFilePath, youtubeUrl, titleToSend, eek) {
     console.log(`Attempting to send original file for chat ${chatId}: ${originalFilePath}`);
     if (await fs.access(originalFilePath).then(() => true).catch(() => false)) {
          try {
              const originalStats = await fs.stat(originalFilePath);
              const originalFileSizeMB = (originalStats.size / (1024 * 1024)).toFixed(2);
              console.log(`Original file size for chat ${chatId}: ${originalFileSizeMB} MB`);

              if (originalStats.size > TELEGRAM_FILE_LIMIT_BYTES) {
                   await eek.reply(`❌ File video asli "${titleToSend}" (${originalFileSizeMB} MB) juga melebihi batas ukuran Telegram (50 MB).`);
              } else {
                   // await eek.reply(`File asli: ${originalFileSizeMB} MB. Mengirim file asli...`); // Opsional
                  await eek.replyWithDocument(
                      { source: originalFilePath, filename: `${titleToSend}_original.mp4` }, // Gunakan judul di nama file
                      { caption: `📽️ ${titleToSend} (Original MP4)\n🔗 ${youtubeUrl}` } // Keterangan dengan judul dan URL
                  );
              }
          } catch (sendOriginalError) {
               console.error(`Failed to send original file via Telegram for chat ${chatId}:`, sendOriginalError.message);
               await eek.reply(`❌ Gagal mengirim file video asli melalui Telegram.`);
          }
     } else {
          console.log(`Original file ${originalFilePath} not found to send for chat ${chatId}.`);
          // Pesan error sudah dikirim di tempat lain jika file tidak ada
          // await eek.reply('❌ File asli tidak ditemukan setelah kegagalan kompresi.'); // Mungkin sudah redundan
     }
     // Cleanup file asli dilakukan di finally block utama MP4
}


// --- Handler Perintah /stop ---
telek.command('stop', async (eek) => {
    const chatId = eek.chat.id;
    const currentDownload = activeDownloads.get(chatId);
    const messageId = eek.message.message_id; // Ambil ID pesan perintah stop

    // Coba hapus pesan perintah /stop segera
     try {
        await telek.telegram.deleteMessage(chatId, messageId);
        console.log(`Deleted user command message ${messageId} in chat ${chatId}`);
    } catch (deleteError) {
        console.error(`Failed to delete user command message ${messageId} in chat ${chatId}:`, deleteError.message);
        // Lanjutkan proses meskipun gagal menghapus pesan
    }


    if (currentDownload) {
        try {
            // Kirim sinyal interrupt (SIGINT) ke proses yt-dlp
            // yt-dlp akan mencoba menyelesaikan download chunk saat ini sebelum keluar
            currentDownload.kill('SIGINT');
            await eek.reply('🛑 Proses download dihentikan.');
        } catch (killError) {
            console.error(`Error killing process for chat ${chatId}:`, killError);
            await eek.reply('🛑 Proses download dihentikan (dengan kemungkinan error saat mematikan proses).');
        } finally {
             // Cleanup state terlepas dari berhasil atau tidaknya kill
            activeDownloads.delete(chatId);
            videoTitles.delete(chatId);
            const progressMsgId = progressMessages.get(chatId);
            if (progressMsgId) {
                // Coba hapus pesan progres, abaikan error jika gagal
                eek.telegram.deleteMessage(chatId, progressMsgId).catch(console.error);
                progressMessages.delete(chatId);
                lastReportedProgress.delete(chatId);
            }
            // Catatan: File parsial mungkin tertinggal di TEMP_DIR setelah dihentikan
            // Anda mungkin perlu proses cleanup terpisah untuk menghapus file lama di TEMP_DIR
        }
    } else {
        await eek.reply('ℹ️ Tidak ada proses download yang sedang berjalan untuk dihentikan.');
    }
});


// --- Jalankan Bot ---
telek.launch();

// Tangani sinyal untuk graceful shutdown
process.once('SIGINT', () => {
    console.log('Stopping bot (SIGINT)');
    // Hentikan semua proses download aktif
    activeDownloads.forEach((process, chatId) => {
        try {
            process.kill('SIGINT'); // Coba SIGINT dulu untuk clean shutdown yt-dlp
            console.log(`Killed download process for chat ${chatId}`);
        } catch (e) {
            console.error(`Failed to kill process for chat ${chatId} on SIGINT`, e);
            try {
                process.kill('SIGKILL'); // Jika SIGINT gagal, paksa dengan SIGKILL
            } catch (e2) {
                 console.error(`Failed to kill process for chat ${chatId} with SIGKILL`, e2);
            }
        }
    });
     // Bersihkan state
    activeDownloads.clear();
    videoTitles.clear();
    progressMessages.clear();
    lastReportedProgress.clear();
    // Anda mungkin ingin menambahkan logika untuk membersihkan TEMP_DIR di sini
    telek.stop('SIGINT');
});
process.once('SIGTERM', () => {
    console.log('Stopping bot (SIGTERM)');
     // Hentikan semua proses download aktif
     activeDownloads.forEach((process, chatId) => {
         try {
             process.kill('SIGTERM'); // Coba SIGTERM dulu
             console.log(`Killed download process for chat ${chatId}`);
         } catch (e) {
             console.error(`Failed to kill process for chat ${chatId} on SIGTERM`, e);
              try {
                process.kill('SIGKILL'); // Jika SIGTERM gagal, paksa dengan SIGKILL
            } catch (e2) {
                 console.error(`Failed to kill process for chat ${chatId} with SIGKILL`, e2);
            }
         }
     });
     // Bersihkan state
     activeDownloads.clear();
     videoTitles.clear();
     progressMessages.clear();
     lastReportedProgress.clear();
    // Anda mungkin ingin menambahkan logika untuk membersihkan TEMP_DIR di sini
    telek.stop('SIGTERM');
});

console.log('🚀 Bot YouTube Downloader berjalan...');
console.log('===================================');
console.log(`Memproses perintah: /start [URL_YOUTUBE] [mp3/mp4]`);
console.log(`Perintah /stop untuk menghentikan download.`);
console.log(`Batas ukuran upload Telegram: 50 MB.`);
console.log(`File sementara akan disimpan di: ${TEMP_DIR}`);

// Tambahan: Anda mungkin perlu proses terjadwal atau eksternal untuk membersihkan direktori TEMP_DIR
// dari file-file lama yang mungkin tidak terhapus karena error atau shutdown paksa.
