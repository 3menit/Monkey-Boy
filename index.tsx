/* tslint:disable */
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI } from '@google/genai';

// --- DOM Elements ---
const apiKeyInput = document.querySelector('#api-key-input') as HTMLTextAreaElement;
const saveApiKeyButton = document.querySelector('#save-api-key-button') as HTMLButtonElement;
const toggleApiKeyVisibilityButton = document.querySelector('#toggle-api-key-visibility-button') as HTMLButtonElement;
const apiKeyStatusEl = document.querySelector('#api-key-status') as HTMLParagraphElement;
const fileInput = document.querySelector('#file-input') as HTMLInputElement;
const dropZoneEl = document.querySelector('#drop-zone') as HTMLDivElement;
const dropZonePrompt = document.querySelector('.drop-zone-prompt') as HTMLDivElement;
const fileQueueContainer = document.querySelector('#file-queue-container') as HTMLDivElement;
const generateButton = document.querySelector('#generate-button') as HTMLButtonElement;
const generateAllPromptsButton = document.querySelector('#generate-all-prompts-button') as HTMLButtonElement;
const downloadAllButton = document.querySelector('#download-all-button') as HTMLButtonElement;
const clearCompletedButton = document.querySelector('#clear-completed-button') as HTMLButtonElement;
const aspectRatioSelect = document.querySelector('#aspect-ratio-select') as HTMLSelectElement;
const qualitySelect = document.querySelector('#quality-select') as HTMLSelectElement;
const quotaErrorEl = document.querySelector('#quota-error') as HTMLDivElement;
const resultsContainer = document.querySelector('#results-container') as HTMLDivElement;
const statusEl = document.querySelector('#status') as HTMLParagraphElement;
const logEntriesEl = document.querySelector('#log-entries') as HTMLDivElement;

const API_KEYS_STORAGE_KEY = 'user_gemini_api_keys';
let fileQueue: any[] = [];
let isGenerating = false;
let isBatchGeneratingPrompts = false;
let targetItemIdForFileUpload: number | null = null;
let currentApiKeyIndex = 0;
let adInjected = false;

// --- Utility Functions ---

function logActivity(message: string) {
    if (!logEntriesEl) return;
    const now = new Date();
    const timestamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    const entry = document.createElement('p');
    entry.className = 'log-entry';
    
    const timeEl = document.createElement('span');
    timeEl.className = 'log-timestamp';
    timeEl.textContent = `[${timestamp}]`;
    
    const msgEl = document.createElement('span');
    msgEl.className = 'log-message';
    msgEl.textContent = message;
    
    entry.appendChild(timeEl);
    entry.appendChild(msgEl);
    
    logEntriesEl.prepend(entry);
}

function getApiKeys(): string[] {
    const storedKeys = localStorage.getItem(API_KEYS_STORAGE_KEY);
    if (storedKeys) {
        try {
            const keys = JSON.parse(storedKeys);
            if (Array.isArray(keys) && keys.length > 0) {
                return keys;
            }
        } catch (e) {
            console.error("Failed to parse API keys from storage", e);
            return [];
        }
    }
    return [];
}

function getNextApiKey(): string | null {
    const keys = getApiKeys();
    if (keys.length === 0) {
        return null;
    }
    const key = keys[currentApiKeyIndex];
    currentApiKeyIndex = (currentApiKeyIndex + 1) % keys.length;
    return key;
}

/**
 * A delay that can be interrupted by setting `isGenerating` to false.
 * @param {number} ms The total time to wait.
 * @param {number} interval The interval at which to check for cancellation.
 * @returns {Promise<void>} A promise that resolves after the delay or rejects on cancellation.
 */
function interruptibleDelay(ms: number, interval = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      if (!isGenerating) {
        reject(new Error('Generation cancelled by user.'));
        return;
      }
      if (Date.now() - startTime >= ms) {
        resolve();
      } else {
        setTimeout(check, Math.min(interval, ms - (Date.now() - startTime)));
      }
    };
    check();
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(',')[1]);
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(blob);
  });
}

function downloadFile(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// --- Core Logic ---

async function generateVideo(prompt: string, imageBytes: string, mimeType: string, apiKey: string) {
  if (!apiKey) {
    throw new Error('API key not available for this worker.');
  }
  const ai = new GoogleGenAI({ apiKey });

  const config: any = {
    model: 'veo-2.0-generate-001',
    prompt,
    config: {
      numberOfVideos: 1,
      aspectRatio: aspectRatioSelect.value,
      quality: qualitySelect.value,
    },
  };

  if (imageBytes) {
    config.image = { imageBytes, mimeType };
  }

  let operation = await ai.models.generateVideos(config);

  while (!operation.done) {
    // This will throw an error if cancelled, which is caught by the worker
    await interruptibleDelay(10000);
    if (!isGenerating) throw new Error('Generation cancelled by user.');
    operation = await ai.operations.getVideosOperation({ operation });
  }

  const videos = operation.response?.generatedVideos;
  if (!videos || videos.length === 0) {
    throw new Error('No videos were generated.');
  }
  
  const firstVideo = videos[0];
  if (firstVideo.video?.uri) {
    const url = `${firstVideo.video.uri}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch video: ${res.statusText}`);
    }
    return res.blob();
  } else {
    throw new Error('Generated video data is incomplete.');
  }
}

function updateGenerateButtonState() {
    if (isGenerating || isBatchGeneratingPrompts) return;
    const hasProcessableItems = fileQueue.some(item => (item.prompt && item.prompt.trim() !== '') || item.file);
    generateButton.disabled = !hasProcessableItems;
}

function updatePromptButtonsState() {
    if (isBatchGeneratingPrompts) {
        // When batch generating, this button is the 'Cancel' button.
        // Its state is managed by `setBatchPromptUIState` and should not be changed here.
        return;
    }
    if (isGenerating) {
        generateAllPromptsButton.disabled = true;
        return;
    }
    const hasPromptableItems = fileQueue.some(item => (item.file || (item.prompt && item.prompt.trim() !== '')));
    generateAllPromptsButton.disabled = !hasPromptableItems;
}

function updateActionButtonsState() {
    const hasCompletedItems = fileQueue.some(item => item.status === 'complete' && item.videoBlob);
    if (hasCompletedItems) {
        downloadAllButton.style.display = 'inline-block';
        clearCompletedButton.style.display = 'inline-block';
    } else {
        downloadAllButton.style.display = 'none';
        clearCompletedButton.style.display = 'none';
    }
}

function setBatchPromptUIState(processing: boolean) {
    fileInput.disabled = processing;
    dropZoneEl.style.pointerEvents = processing ? 'none' : 'auto';
    dropZoneEl.style.opacity = processing ? '0.6' : '1';
    aspectRatioSelect.disabled = processing;
    qualitySelect.disabled = processing;
    apiKeyInput.disabled = processing;
    saveApiKeyButton.disabled = processing;
    toggleApiKeyVisibilityButton.disabled = processing;
    generateButton.disabled = processing;
    downloadAllButton.disabled = processing;
    clearCompletedButton.disabled = processing;

    if (processing) {
        generateAllPromptsButton.textContent = 'Cancel Prompts';
        generateAllPromptsButton.classList.add('cancel-button');
        generateAllPromptsButton.disabled = false; // Enable cancel button
    } else {
        generateAllPromptsButton.textContent = 'Generate All Prompts';
        generateAllPromptsButton.classList.remove('cancel-button');
    }

    document.querySelectorAll('.item-prompt-input, .item-generate-prompt-button, .remove-item-button, .remove-image-button, .queue-item-image-placeholder').forEach((el: HTMLElement) => {
        (el as HTMLInputElement).disabled = processing;
        el.style.pointerEvents = processing ? 'none' : 'auto';
    });

    if (!processing) {
        updateGenerateButtonState();
        updatePromptButtonsState();
        updateActionButtonsState();
    }
}


function setUIState(generating: boolean) {
  fileInput.disabled = generating;
  dropZoneEl.style.pointerEvents = generating ? 'none' : 'auto';
  dropZoneEl.style.opacity = generating ? '0.6' : '1';
  aspectRatioSelect.disabled = generating;
  qualitySelect.disabled = generating;
  apiKeyInput.disabled = generating;
  saveApiKeyButton.disabled = generating;
  toggleApiKeyVisibilityButton.disabled = generating;
  generateAllPromptsButton.disabled = generating;
  downloadAllButton.disabled = generating;
  clearCompletedButton.disabled = generating;


  if (generating) {
    generateButton.textContent = 'Cancel';
    generateButton.classList.add('cancel-button');
    generateButton.disabled = false; // Enable the cancel button
  } else {
    generateButton.textContent = 'Generate';
    generateButton.classList.remove('cancel-button');
    updateGenerateButtonState(); // Set disabled state based on queue
    updatePromptButtonsState();
    updateActionButtonsState();
  }
  
  // Disable per-item controls during generation
  document.querySelectorAll('.item-prompt-input, .item-generate-prompt-button, .remove-item-button, .remove-image-button, .queue-item-image-placeholder').forEach((el: HTMLElement) => {
    (el as HTMLInputElement).disabled = generating;
    if (generating) el.style.pointerEvents = 'none';
    else el.style.pointerEvents = 'auto';
  });
}

function createVideoResult(file: File, videoBlob: Blob) {
    const videoObjectUrl = URL.createObjectURL(videoBlob);
    
    const card = document.createElement('div');
    card.className = 'result-card';
    
    const title = document.createElement('h3');
    title.textContent = file.name;
    card.appendChild(title);

    const video = document.createElement('video');
    video.src = videoObjectUrl;
    video.autoplay = true;
    video.controls = true;
    video.loop = true;
    video.muted = true;
    card.appendChild(video);
    
    const actions = document.createElement('div');
    actions.className = 'video-actions';
    
    const downloadButton = document.createElement('button');
    downloadButton.className = 'download-button';
    downloadButton.textContent = 'Download Video';
    downloadButton.addEventListener('click', () => {
        downloadFile(videoObjectUrl, `video_for_${file.name}.mp4`);
        downloadButton.textContent = 'Downloaded ✓';
        downloadButton.disabled = true;
        downloadButton.classList.add('downloaded');
    });
    actions.appendChild(downloadButton);
    card.appendChild(actions);
    
    resultsContainer.appendChild(card);

    // Inject an ad card into the results grid after the first video, but only once per batch.
    if (!adInjected) {
        const adCard = document.createElement('div');
        adCard.className = 'result-card native-ad-placeholder';
        
        const adContainer = document.createElement('div');
        adContainer.id = 'container-ddd559f2d98723b5096dc35a62d88870';
        adCard.appendChild(adContainer);
        
        resultsContainer.appendChild(adCard);

        // Remove the old ad script if it exists to ensure the new one runs correctly
        const oldScript = document.querySelector('script[src*="niecesprivilegelimelight.com"]');
        if (oldScript) {
            oldScript.remove();
        }

        // Dynamically load the ad script so it finds the newly created container
        const adScript = document.createElement('script');
        adScript.async = true;
        adScript.dataset.cfasync = 'false';
        adScript.src = '//niecesprivilegelimelight.com/ddd559f2d98723b5096dc35a62d88870/invoke.js';
        document.body.appendChild(adScript);

        adInjected = true;
        logActivity('Ad placeholder injected into results grid.');
    }
}

async function startGeneration() {
  const apiKeys = getApiKeys();
  if (apiKeys.length === 0) {
    const msg = 'API Key not configured. Please enter and save your API key(s).';
    statusEl.innerText = msg;
    quotaErrorEl.innerHTML = `<p>${msg}</p>`;
    quotaErrorEl.style.display = 'block';
    logActivity('Generation failed: No API keys configured.');
    return;
  }
  
  const itemsToProcess = fileQueue.filter(item => (item.prompt && item.prompt.trim() !== '') || item.file);
  if (itemsToProcess.length === 0) {
    const msg = 'Please add at least one item with an image or a prompt.';
    statusEl.innerText = msg;
    logActivity(`Generation skipped: ${msg}`);
    return;
  }

  isGenerating = true;
  setUIState(true);
  quotaErrorEl.style.display = 'none';
  
  // Clear previous results and blobs
  fileQueue.forEach(item => { delete item.videoBlob; });
  resultsContainer.innerHTML = '';
  adInjected = false; // Reset the ad injection flag
  updateActionButtonsState();
  
  const MAX_VIDEO_WORKERS = 5;
  const concurrency = Math.min(apiKeys.length, itemsToProcess.length, MAX_VIDEO_WORKERS);
  logActivity(`Batch generation started with ${concurrency} parallel worker(s) (max ${MAX_VIDEO_WORKERS}).`);
  
  // Reset statuses for all processable items
  fileQueue.forEach(item => {
    if ((item.prompt && item.prompt.trim() !== '') || item.file) {
      item.status = 'queued';
      item.error = undefined; // Clear previous errors
    } else {
      item.status = 'skipped';
    }
  });
  renderQueue();

  const runWorker = async (workerId: number, apiKey: string) => {
    logActivity(`Worker ${workerId + 1} starting with its assigned API key.`);
    while (isGenerating) {
      // Find a job to do. This is atomic in single-threaded JS.
      const item = fileQueue.find(i => i.status === 'queued' || i.status === 'error');
      
      if (!item) {
        break; // No more work to do
      }
      
      item.status = 'processing';
      renderQueue(); // Show this item is being processed

      const totalFiles = fileQueue.filter(i => i.status !== 'skipped').length;
      const completedFiles = fileQueue.filter(i => i.status === 'complete').length;
      const processingFiles = fileQueue.filter(i => i.status === 'processing').length;
      const itemName = item.file?.name || `Prompt Item #${item.id.toFixed()}`;
      
      statusEl.innerText = `Processing: ${processingFiles} running, ${completedFiles}/${totalFiles} complete.`;
      logActivity(`Worker ${workerId + 1}: Starting on "${itemName}".`);

      try {
        let promptForGeneration = item.prompt || '';
        if (promptForGeneration.trim() === '' && item.file) {
            promptForGeneration = "Animate this image, bringing it to life.";
        }
        
        const videoBlob = await generateVideo(promptForGeneration, item.base64, item.file?.type, apiKey);
        item.videoBlob = videoBlob; // Store the blob for later download
        
        const resultFile = item.file || { name: `prompt_item_${item.id.toFixed()}` };
        createVideoResult(resultFile, videoBlob);
        item.status = 'complete';
        logActivity(`Worker ${workerId + 1}: Successfully generated video for "${itemName}".`);
      } catch (e: any) {
        if (!isGenerating) break; // Exit if cancelled during generation
        console.error(`Worker ${workerId + 1} error processing item ${item.id}:`, e);
        item.status = 'error';
        item.error = e.message;
        logActivity(`Worker ${workerId + 1}: Error on item "${itemName}": ${e.message}`);
        
        // More specific error handling for API key issues
        const errorMessage = e.message.toLowerCase();
        if (errorMessage.includes('api key not valid') || errorMessage.includes('429') || errorMessage.includes('permission') || errorMessage.includes('referrer')) {
            const domainSpan = document.getElementById('quota-error-domain');
            if (domainSpan) {
                domainSpan.textContent = window.location.hostname || 'your-local-environment';
            }
            quotaErrorEl.style.display = 'block';
            logActivity(`API Key error detected. Displaying domain restriction message for ${window.location.hostname}.`);
        }
        statusEl.innerText = `Error on an item. Worker will pick up another task.`;
      } finally {
        if (isGenerating) {
           renderQueue();
        }
      }
    }
    logActivity(`Worker ${workerId + 1} finished.`);
  };

  // Start all workers
  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(runWorker(i, apiKeys[i]));
  }

  // Wait for all workers to complete
  await Promise.all(workers);

  if (!isGenerating) {
    statusEl.innerText = 'Generation cancelled.';
    logActivity('Generation process cancelled by user.');
    fileQueue.forEach(i => {
      if (i.status === 'processing' && ((i.prompt && i.prompt.trim() !== '') || i.file)) {
        i.status = 'queued'; // Re-queue items that were being processed
      }
    });
    renderQueue();
  } else {
    const failedItems = fileQueue.filter(i => i.status === 'error').length;
    if (failedItems > 0) {
        statusEl.innerText = `Batch processing complete with ${failedItems} error(s).`;
        logActivity(`Batch processing complete with ${failedItems} error(s).`);
    } else {
        statusEl.innerText = 'Batch processing complete.';
        logActivity('Batch processing complete.');
    }
  }
  
  isGenerating = false;
  setUIState(false);
}

// --- UI and Event Listeners ---

function renderQueue() {
  fileQueueContainer.innerHTML = '';
  if (fileQueue.length > 0) {
    dropZoneEl.classList.add('has-files');
    dropZonePrompt.style.display = 'none';
  } else {
    dropZoneEl.classList.remove('has-files');
    dropZonePrompt.style.display = 'block';
  }

  fileQueue.forEach(item => {
      const itemEl = document.createElement('div');
      itemEl.className = 'queue-item';
      itemEl.dataset.id = item.id;
      itemEl.dataset.status = item.status;
      
      const imageContainerEl = document.createElement('div');
      imageContainerEl.className = 'queue-item-image-container';

      if (item.file && item.objectUrl) {
        const thumb = document.createElement('img');
        thumb.className = 'queue-item-thumbnail';
        thumb.src = item.objectUrl;
        imageContainerEl.appendChild(thumb);

        const removeImageBtn = document.createElement('button');
        removeImageBtn.className = 'remove-image-button';
        removeImageBtn.innerHTML = '&times;';
        removeImageBtn.title = 'Remove Image';
        removeImageBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeImageFromItem(item.id);
        });
        imageContainerEl.appendChild(removeImageBtn);
      } else {
        const placeholderEl = document.createElement('div');
        placeholderEl.className = 'queue-item-image-placeholder';
        placeholderEl.textContent = 'Add Image';
        placeholderEl.addEventListener('click', () => {
            targetItemIdForFileUpload = item.id;
            fileInput.multiple = false;
            fileInput.click();
        });
        placeholderEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            placeholderEl.classList.add('drag-over-item');
        });
        placeholderEl.addEventListener('dragleave', () => {
            placeholderEl.classList.remove('drag-over-item');
        });
        placeholderEl.addEventListener('drop', async (e) => {
            e.preventDefault();
            placeholderEl.classList.remove('drag-over-item');
            const droppedFile = e.dataTransfer?.files?.[0];
            if (droppedFile) {
                await addImageToItem(item.id, droppedFile);
            }
        });
        imageContainerEl.appendChild(placeholderEl);
      }
      itemEl.appendChild(imageContainerEl);
      
      const contentEl = document.createElement('div');
      contentEl.className = 'queue-item-content';
      
      const info = document.createElement('div');
      info.className = 'queue-item-info';
      
      const name = document.createElement('p');
      name.className = 'queue-item-name';
      name.textContent = item.file?.name || 'Prompt only';
      name.title = item.file?.name || 'Prompt only';
      info.appendChild(name);
      
      const status = document.createElement('p');
      status.className = 'queue-item-status';
      let statusText = item.status.charAt(0).toUpperCase() + item.status.slice(1);
      if (item.status === 'error') {
          statusText += `: ${item.error || 'Unknown error'}`;
      } else if (item.status === 'skipped') {
          statusText = 'Skipped (no image or prompt)';
      } else if (item.status === 'generating-prompt') {
          statusText = 'Generating prompt...';
      }
      status.textContent = statusText;
      info.appendChild(status);
      contentEl.appendChild(info);

      const promptInput = document.createElement('textarea');
      promptInput.className = 'item-prompt-input';
      promptInput.placeholder = 'Enter a prompt or generate one...';
      promptInput.value = item.prompt;
      promptInput.rows = 3;
      promptInput.addEventListener('input', () => {
          const currentItem = fileQueue.find(i => i.id === item.id);
          if (currentItem) {
              currentItem.prompt = promptInput.value;
          }
          renderQueue(); // Re-render to update button states
      });
      contentEl.appendChild(promptInput);
      
      const promptActions = document.createElement('div');
      promptActions.className = 'item-prompt-actions';
      const genPromptBtn = document.createElement('button');
      genPromptBtn.className = 'item-generate-prompt-button';
      genPromptBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const key = getNextApiKey();
          if (!key) {
              alert('Cannot generate prompt: No API key configured.');
              return;
          }
          generatePromptForImage(item.id, key);
      });
      
      const canGeneratePrompt = !!item.file || (!!item.prompt && item.prompt.trim() !== '');
      genPromptBtn.disabled = !canGeneratePrompt || item.status === 'generating-prompt';

      if (item.status === 'generating-prompt') {
          genPromptBtn.textContent = 'Generating...';
      } else if (item.file) {
          genPromptBtn.textContent = 'Generate Prompt';
      } else {
          genPromptBtn.textContent = 'Improve Prompt';
      }
      
      promptActions.appendChild(genPromptBtn);
      contentEl.appendChild(promptActions);
      
      itemEl.appendChild(contentEl);

      const removeButton = document.createElement('button');
      removeButton.className = 'remove-item-button';
      removeButton.innerHTML = '&times;';
      removeButton.title = 'Remove item from queue';
      removeButton.addEventListener('click', (e) => {
          e.stopPropagation();
          removeQueueItem(item.id);
      });
      itemEl.appendChild(removeButton);

      fileQueueContainer.appendChild(itemEl);
  });
  updateGenerateButtonState();
  updatePromptButtonsState();
  updateActionButtonsState();
}

function removeQueueItem(id: number) {
    const item = fileQueue.find(i => i.id === id);
    if (item) {
        if (item.objectUrl) {
            URL.revokeObjectURL(item.objectUrl);
        }
        const itemName = item.file?.name || `Prompt Item #${item.id.toFixed()}`;
        logActivity(`Removed "${itemName}" from the queue.`);
    }
    fileQueue = fileQueue.filter(item => item.id !== id);
    renderQueue();
}

function removeImageFromItem(id: number) {
    const item = fileQueue.find(i => i.id === id);
    if (item) {
        if (item.objectUrl) {
            URL.revokeObjectURL(item.objectUrl);
            const itemName = item.file?.name || `Prompt Item #${item.id.toFixed()}`;
            logActivity(`Removed image from "${itemName}".`);
        }
        item.file = null;
        item.base64 = null;
        item.objectUrl = null;
    }
    renderQueue();
}

async function addImageToItem(id: number, file: File) {
    const item = fileQueue.find(i => i.id === id);
    if (!item) return;

    if (!file || !file.type.startsWith('image/')) {
        alert('Please select an image file.');
        return;
    }

    try {
        item.base64 = await blobToBase64(file);
        item.file = file;
        item.objectUrl = URL.createObjectURL(file);
        const itemName = `Prompt Item #${item.id.toFixed()}`;
        logActivity(`Added image "${file.name}" to "${itemName}".`);
        renderQueue();
    } catch (error) {
        console.error("Error adding image to item:", error);
        alert('Failed to process the selected image.');
    }
}

async function handleFiles(files: FileList | null) {
  if (!files || files.length === 0) return;

  for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) {
          logActivity(`Skipped non-image file: ${file.name}`);
          alert(`Skipping non-image file: ${file.name}`);
          continue;
      }
      const base64 = await blobToBase64(file);
      const id = Date.now() + Math.random();
      const objectUrl = URL.createObjectURL(file);
      fileQueue.push({ id, file, base64, objectUrl, status: 'queued', prompt: '' });
  }
  logActivity(`Added ${files.length} file(s) to the queue.`);
  renderQueue();
}

async function generatePromptForImage(itemId: number, apiKey: string) {
  const item = fileQueue.find(i => i.id === itemId);
  if (!item) return;

  const hasImage = !!item.file;
  const hasPrompt = item.prompt && item.prompt.trim() !== '';

  if (!hasImage && !hasPrompt) {
    alert("An image or an existing prompt is required to generate a new prompt.");
    return;
  }
  
  if (!apiKey) {
    statusEl.innerText = 'Cannot generate prompt: API key not configured.';
    logActivity('Prompt generation failed: No API keys.');
    return;
  }
  
  const itemName = item.file?.name || `Prompt Item #${item.id.toFixed()}`;
  const action = hasImage ? 'Generating prompt for' : 'Improving prompt for';
  logActivity(`${action} "${itemName}".`);

  const originalStatus = item.status;
  item.status = 'generating-prompt';
  renderQueue();

  try {
    const ai = new GoogleGenAI({ apiKey });
    let response;
    
    if (hasImage) {
        const textPart = { text: 'Describe this image for a video generation model. The description should be vivid, detailed, and focus on potential motion.' };
        const imagePart = { inlineData: { mimeType: item.file.type, data: item.base64 } };

        response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: { parts: [imagePart, textPart] },
        });
    } else { // hasPrompt is true
        const userContent = `Rephrase and improve this video prompt for a generative AI model, making it more descriptive and evocative: "${item.prompt}"`;
        response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: userContent,
        });
    }

    item.prompt = response.text.trim();
    item.status = originalStatus === 'generating-prompt' ? 'queued' : originalStatus;
    logActivity(`Successfully updated prompt for "${itemName}".`);
  } catch (e) {
    console.error('Error generating prompt:', e);
    item.status = 'error';
    item.error = 'Prompt generation failed.';
    logActivity(`Prompt generation failed for "${itemName}".`);
  } finally {
    renderQueue();
  }
}

async function startBatchPromptGeneration() {
    if (isGenerating || isBatchGeneratingPrompts) {
        alert("Please wait for the current process to complete.");
        return;
    }

    const apiKeys = getApiKeys();
    if (apiKeys.length === 0) {
        alert('Cannot generate prompts: No API keys configured.');
        logActivity('Batch prompt generation failed: No API keys.');
        return;
    }

    const itemsToProcess = fileQueue.filter(item => (item.file || (item.prompt && item.prompt.trim() !== '')));
    if (itemsToProcess.length === 0) {
        alert('No items in the queue need a prompt to be generated or improved.');
        return;
    }

    isBatchGeneratingPrompts = true;
    setBatchPromptUIState(true);
    statusEl.innerText = `Generating prompts for ${itemsToProcess.length} items...`;

    const MAX_PROMPT_WORKERS = 5;
    const concurrency = Math.min(apiKeys.length, itemsToProcess.length, MAX_PROMPT_WORKERS);
    logActivity(`Starting batch prompt generation for ${itemsToProcess.length} items with ${concurrency} worker(s).`);

    fileQueue.forEach(item => {
        delete item.promptGenerationStarted;
    });

    const runPromptWorker = async (apiKey: string) => {
        while (isBatchGeneratingPrompts) {
            const item = fileQueue.find(i => (i.file || (i.prompt && i.prompt.trim() !== '')) && !i.promptGenerationStarted);
            if (!item) break;

            item.promptGenerationStarted = true;
            await generatePromptForImage(item.id, apiKey);
        }
    };

    const workers = apiKeys.slice(0, concurrency).map(apiKey => runPromptWorker(apiKey));
    await Promise.all(workers);

    fileQueue.forEach(item => delete item.promptGenerationStarted);

    if (!isBatchGeneratingPrompts) { // Flag was changed by the cancel button
        logActivity('Batch prompt generation cancelled.');
        statusEl.innerText = 'Batch prompt generation cancelled.';
    } else {
        logActivity('Batch prompt generation complete.');
        statusEl.innerText = 'Batch prompt generation complete.';
    }
    
    isBatchGeneratingPrompts = false;
    setBatchPromptUIState(false);
}


function saveApiKey() {
  const keys = apiKeyInput.value
    .split('\n')
    .map(k => k.trim())
    .filter(k => k);

  if (keys.length > 0) {
    localStorage.setItem(API_KEYS_STORAGE_KEY, JSON.stringify(keys));
    const msg = `${keys.length} API Key(s) saved.`;
    alert(msg);
    logActivity(msg);
  } else {
    localStorage.removeItem(API_KEYS_STORAGE_KEY);
    apiKeyInput.value = '';
    alert('API Keys removed.');
    logActivity('API Keys removed.');
  }
  loadApiKey();
}

function loadApiKey() {
  const savedKeys = getApiKeys();
  if (savedKeys.length > 0) {
    apiKeyInput.value = savedKeys.join('\n');
    const plural = savedKeys.length > 1 ? 's' : '';
    const msg = `${savedKeys.length} key${plural} loaded from local storage.`;
    apiKeyStatusEl.textContent = msg;
    logActivity(msg);
    apiKeyInput.placeholder = 'Using your saved API keys';
    apiKeyInput.classList.add('keys-hidden');
    toggleApiKeyVisibilityButton.textContent = 'Show';
  } else {
    const msg = 'No API key found. Please get a key and enter it above.';
    apiKeyStatusEl.innerHTML = 'No API key found. Please <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">get an API key</a> and enter it above to use the app.';
    logActivity(msg);
    apiKeyInput.placeholder = 'Enter one or more API keys, one per line';
    apiKeyInput.classList.remove('keys-hidden');
    toggleApiKeyVisibilityButton.textContent = 'Hide';
  }
}

async function handleDownloadAll() {
    const itemsToDownload = fileQueue.filter(item => item.status === 'complete' && item.videoBlob);
    if (itemsToDownload.length === 0) {
        alert('No videos available to download.');
        return;
    }

    logActivity(`Preparing to download ${itemsToDownload.length} videos as a zip file...`);
    downloadAllButton.textContent = 'Zipping...';
    downloadAllButton.disabled = true;

    try {
        // Dynamic import for JSZip
        const { default: JSZip } = await import('https://esm.sh/jszip@3.10.1');
        const zip = new JSZip();

        for (const item of itemsToDownload) {
            const fileName = `video_for_${item.file?.name || `prompt_item_${item.id.toFixed()}`}.mp4`;
            zip.file(fileName, item.videoBlob!);
        }

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadFile(URL.createObjectURL(zipBlob), `generated_videos_${timestamp}.zip`);
        
        logActivity(`Successfully created zip file for download.`);
        downloadAllButton.textContent = 'Downloaded ✓';
        setTimeout(() => {
            downloadAllButton.textContent = 'Download All';
            downloadAllButton.disabled = false;
        }, 3000);

    } catch (e: any) {
        console.error('Error creating zip file:', e);
        logActivity(`Error creating zip file: ${e.message}`);
        alert('An error occurred while creating the zip file.');
        downloadAllButton.textContent = 'Download All';
        downloadAllButton.disabled = false;
    }
}

function handleClearCompleted() {
    const completedCount = fileQueue.filter(item => item.status === 'complete').length;
    if (completedCount === 0) return;

    logActivity(`Clearing ${completedCount} completed item(s).`);
    
    // Filter out completed items from the queue
    fileQueue = fileQueue.filter(item => item.status !== 'complete');
    
    // Clear the visual results
    resultsContainer.innerHTML = '';
    
    // Re-render the queue to reflect the changes and update button visibility
    renderQueue();
}

// --- Application Initialization ---

function initializeApp() {
  // --- Local File Protocol Check ---
  if (window.location.protocol === 'file:') {
    (document.getElementById('app-container') as HTMLElement).style.display = 'none';
    (document.getElementById('local-file-warning') as HTMLElement).style.display = 'block';
    return; // Stop initialization if on file protocol
  }

  // --- Prevent browser's default file open behavior ---
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
  });

  // Add Event Listeners
  fileInput.addEventListener('change', async (e) => {
    const target = e.target as HTMLInputElement;
    if (targetItemIdForFileUpload) {
        const file = target.files?.[0];
        if (file) {
            await addImageToItem(targetItemIdForFileUpload, file);
        }
        targetItemIdForFileUpload = null;
        fileInput.multiple = true; // Reset for main drop zone
    } else {
      await handleFiles(target.files);
    }
    target.value = ''; // Allow re-selecting the same file(s)
  });

  dropZoneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZoneEl.classList.add('drag-over');
  });

  dropZoneEl.addEventListener('dragleave', () => {
    dropZoneEl.classList.remove('drag-over');
  });

  dropZoneEl.addEventListener('drop', async (e: DragEvent) => {
    e.preventDefault();
    dropZoneEl.classList.remove('drag-over');
    await handleFiles(e.dataTransfer?.files);
  });

  generateButton.addEventListener('click', () => {
    if (isGenerating) {
      // Request cancellation
      isGenerating = false;
      // Provide immediate UI feedback that the request was received
      statusEl.innerText = 'Cancelling... waiting for current step to complete.';
      generateButton.disabled = true;
      generateButton.textContent = 'Cancelling...';
      generateButton.classList.remove('cancel-button');
    } else {
      startGeneration();
    }
  });

  generateAllPromptsButton.addEventListener('click', () => {
    if (isBatchGeneratingPrompts) {
      // Request cancellation
      isBatchGeneratingPrompts = false;
      // Provide immediate UI feedback
      statusEl.innerText = 'Cancelling prompt generation...';
      generateAllPromptsButton.disabled = true;
      generateAllPromptsButton.textContent = 'Cancelling...';
      generateAllPromptsButton.classList.remove('cancel-button');
      logActivity('User requested to cancel batch prompt generation.');
    } else {
      startBatchPromptGeneration();
    }
  });

  downloadAllButton.addEventListener('click', handleDownloadAll);
  
  clearCompletedButton.addEventListener('click', handleClearCompleted);

  saveApiKeyButton.addEventListener('click', saveApiKey);
  
  toggleApiKeyVisibilityButton.addEventListener('click', () => {
    if (apiKeyInput.classList.contains('keys-hidden')) {
      apiKeyInput.classList.remove('keys-hidden');
      toggleApiKeyVisibilityButton.textContent = 'Hide';
    } else {
      apiKeyInput.classList.add('keys-hidden');
      toggleApiKeyVisibilityButton.textContent = 'Show';
    }
  });

  // Initialize
  logActivity('Application initialized.');
  loadApiKey();
  updateGenerateButtonState();
  updatePromptButtonsState();
  updateActionButtonsState();
}

// Start the app
initializeApp();