const path = require('path');
const Logger = require('../utils/logger');
const config = require('../config');

let tesseractAvailable = false;
try {
    require('tesseract.js');
    tesseractAvailable = true;
} catch (e) {
    Logger.warn('tesseract.js not available, OCR will be disabled');
}

let sharpAvailable = false;
try {
    require('sharp');
    sharpAvailable = true;
} catch (e) {
    Logger.warn('sharp not available, PDF page rendering will be limited');
}

class OCRService {
    async extractTextFromImage(buffer) {
        if (!tesseractAvailable) {
            throw new Error('tesseract.js is not installed. Run: npm install tesseract.js');
        }

        const Tesseract = require('tesseract.js');
        const result = await Tesseract.recognize(buffer, 'rus+eng', {
            langPath: process.env.TESSERACT_LANG_PATH || path.join(__dirname, '../../'),
            logger: m => {
                if (m.status === 'recognizing text') {
                    Logger.info(`OCR: ${Math.round(m.progress * 100)}%`);
                }
            }
        });
        return result.data.text;
    }

    async extractTextFromPDF(pdfBuffer) {
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(pdfBuffer);

        if (pdfData.text && pdfData.text.trim().length > 20) {
            return pdfData.text;
        }

        if (!sharpAvailable) {
            Logger.warn('PDF has no text and sharp is not available for page rendering. OCR cannot proceed.');
            return '';
        }

        Logger.info('PDF has no extractable text, attempting OCR...');

        const sharp = require('sharp');
        try {
            const firstPage = sharp(pdfBuffer, { density: 200, page: 0 });
            const metadata = await firstPage.metadata();
            const totalPages = Math.max(metadata.pages || 1, 1);
            const pageTexts = [];

            for (let page = 0; page < totalPages; page++) {
                try {
                    Logger.info(`OCR PDF page ${page + 1}/${totalPages}`);
                    const imageBuffer = await sharp(pdfBuffer, { density: 200, page })
                        .flatten({ background: '#ffffff' })
                        .png()
                        .toBuffer();
                    const pageText = await this.extractTextFromImage(imageBuffer);
                    if (pageText && pageText.trim()) {
                        pageTexts.push(pageText.trim());
                    }
                } catch (pageError) {
                    Logger.warn(`Failed OCR on PDF page ${page + 1}: ${pageError.message}`);
                }
            }

            return pageTexts.join('\n\n').trim();
        } catch (error) {
            Logger.warn(`PDF OCR renderer unavailable: ${error.message}`);
            return '';
        }
    }
}

module.exports = new OCRService();
