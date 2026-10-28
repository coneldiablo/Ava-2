/**
 * Sharp module mock for environments where native sharp binary is not available.
 * 
 * @xenova/transformers only uses sharp for image processing (RawImage class).
 * For text-only operations (embeddings, feature-extraction), sharp is never called.
 * This mock allows transformers to load without the native binary.
 * 
 * MUST be required BEFORE @xenova/transformers or any module that depends on sharp.
 */

'use strict';

// Check if sharp actually works
let sharpWorks = false;
try {
    require('sharp');
    sharpWorks = true;
} catch (e) {
    // Sharp native binary not available — install mock
}

if (!sharpWorks) {
    const path = require('path');
    const sharpPkgPath = require.resolve('sharp/package.json');
    const sharpJsPath = path.join(sharpPkgPath, '..', 'lib', 'sharp.js');
    
    // Create a comprehensive mock of the native sharp binding
    // This must match all functions called by sharp/lib/utility.js and other internal files
    const nativeMock = {
        format: () => ({
            jpeg: { id: 'jpeg', input: { file: true, buffer: true, stream: true }, output: { file: true, buffer: true, stream: true } },
            png: { id: 'png', input: { file: true, buffer: true, stream: true }, output: { file: true, buffer: true, stream: true } },
            webp: { id: 'webp', input: { file: true, buffer: true, stream: true }, output: { file: true, buffer: true, stream: true } },
            tiff: { id: 'tiff', input: { file: true, buffer: true, stream: true }, output: { file: true, buffer: true, stream: true } },
            gif: { id: 'gif', input: { file: true, buffer: true, stream: true }, output: { file: true, buffer: true, stream: true } },
            jp2k: { id: 'jp2k', input: { file: false, buffer: false, stream: false }, output: { file: false, buffer: false, stream: false } },
            heif: { id: 'heif', input: { file: false, buffer: false, stream: false }, output: { file: false, buffer: false, stream: false } },
            raw: { id: 'raw', input: { file: false, buffer: false, stream: false }, output: { file: false, buffer: true, stream: false } },
            svg: { id: 'svg', input: { file: true, buffer: true, stream: true }, output: { file: false, buffer: false, stream: false } },
        }),
        libvipsVersion: () => '8.14.5',
        versions: () => ({
            vips: '8.14.5',
            sharp: '0.35.4-mock',
        }),
        cache: (memory, files, items) => ({
            memory: { current: 0, high: 0, max: memory || 50 },
            files: { current: 0, max: files || 20 },
            items: { current: 0, max: items || 100 },
        }),
        concurrency: (val) => val || 1,
        counters: () => ({ queue: 0, process: 0 }),
        simd: (val) => !!val,
        block: () => {},
        unblock: () => {},
        _isUsingJemalloc: () => false,
    };
    
    // Replace the sharp.js module in require cache
    require.cache[sharpJsPath] = {
        id: sharpJsPath,
        filename: sharpJsPath,
        loaded: true,
        exports: nativeMock,
    };
    
    console.log('[sharp-mock] Sharp native binary not available — using mock for text-only operations');
}

module.exports = { sharpWorks };
