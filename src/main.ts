import { App, Menu, Notice, Plugin, PluginSettingTab, Setting, debounce, TFile, MarkdownView, ButtonComponent, TextComponent} from 'obsidian';

interface LinkNavigationSettings {
    searchCanvasLinks: boolean;
    cacheTimeout: number;
    showCanvasLinks: boolean;
    showCacheCleanupNotice: boolean;
    cacheCleanupInterval: number;
}

type TimeoutId = ReturnType<typeof setTimeout>;

const DEFAULT_SETTINGS: LinkNavigationSettings = {
    searchCanvasLinks: true,
    cacheTimeout: 5 * 60 * 1000, // 5 minutes
    showCanvasLinks: true,
    cacheCleanupInterval: 5, // 5 minutes
    showCacheCleanupNotice: true
}

interface CacheEntry {
    inlinks: string[];
    outlinks: string[];
    canvasLinks: string[];
    timestamp: number;
}

export default class LinkNavigationPlugin extends Plugin {
    settings: LinkNavigationSettings;
    maxDepth = 1;
    depthInput: TextComponent;
    applyButton: ButtonComponent;
    private inlinksEl: HTMLElement | null = null;
    private outlinksEl: HTMLElement | null = null;
    private detailsEl: HTMLElement | null = null;
    private isDetailsVisible = false;
    private showCanvasLinks = true;
    private outlinksOfInlinksVisible = false;
    // Add Cache
    private cache: Map<string, CacheEntry> = new Map();
    private loadingPromises: Map<string, Promise<CacheEntry>> = new Map();
    private maxCacheSize = 200; // Adjust based on performance and memory usage
    private dirtyCache: Set<string> = new Set();
    showCacheCleanupNotice: true;
    private cacheCleanupInterval: TimeoutId | null = null;
    private lastCleanupNotice = 0;
    private readonly CLEANUP_NOTICE_COOLDOWN = 5000; // 5 seconds cooldown

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new LinkNavigationSettingTab(this.app, this));

        // Load saved toggle states
        this.showCanvasLinks = this.settings.showCanvasLinks;
        
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file instanceof TFile) {
                    this.updateLinkNavigation(file);
                }
            })
        );
        
        // Following makes header blink. Look into better options to detect change.
        // To update the DetailedView when new links are created, we'll need 
        // to listen for file changes and update the cache accordingly.
        // this.registerEvent(
        //     this.app.vault.on('modify', (file) => {
        //         if (file instanceof TFile) {
        //             this.invalidateCache(file);
        //             const activeFile = this.app.workspace.getActiveFile();
        //             if (activeFile && activeFile.path === file.path) {
        //                 this.updateLinkNavigation(file);
        // Slight debounce, to avoid unnecessary updates during rapid changes
        //                 this.debouncedUpdateLinkNavigation(file, false);
        //             }
        //         }
        //     })
        // );
        this.addCommand({
            id: 'force-refresh-link-navigation',
            name: 'Force Refresh Link Navigation',
            callback: () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                    this.updateLinkNavigation(activeFile, true);
                }
            }
        });
        this.setupCacheCleanup();

    }

    onunload() {
        this.removeLinkNavigation();
        document.removeEventListener('click', this.handleClickOutside);
        // Clears Cache and Promises
        this.cache.clear();
        this.loadingPromises.clear();
        this.dirtyCache.clear();

        // Remove periodic cache cleanup interval
        if (this.cacheCleanupInterval !== null) {
            clearInterval(this.cacheCleanupInterval);
            this.cacheCleanupInterval = null;
        }
        
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
    
    // 1. Show LinkNavigation in the header
    async updateLinkNavigation(file: TFile, forceRefresh = false) {
        if (forceRefresh) {
            this.invalidateCache(file);
        }
    
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !(view instanceof MarkdownView)) return;
    
        const viewHeader = view.containerEl.querySelector('.view-header');
        if (!viewHeader) return;
    
        const viewHeaderTitle = viewHeader.querySelector('.view-header-title');
        if (!viewHeaderTitle) return;
    
        this.removeLinkNavigation();
    
        // Create elements
        this.inlinksEl = viewHeader.createEl('div', { cls: 'link-navigator-inlinks link-navigator-visible' });
        this.outlinksEl = viewHeader.createEl('div', { cls: 'link-navigator-outlinks link-navigator-visible' });
        this.inlinksEl.textContent = 'INLINKS (0)';
        this.outlinksEl.textContent = 'OUTLINKS (0)';
        viewHeaderTitle.before(this.inlinksEl);
        viewHeaderTitle.after(this.outlinksEl);
    
        try {
            const { inlinks, outlinks, canvasLinks } = await this.cacheLinkData(file);
    
            requestAnimationFrame(() => {
                if (this.inlinksEl && this.outlinksEl) {
                    const totalOutlinks = outlinks.length + canvasLinks.length;
                    this.inlinksEl.textContent = `← INLINKS (${inlinks.length})`;
                    this.outlinksEl.textContent = `OUTLINKS (${totalOutlinks}) →`;
    
                    this.setupHoverPreview(this.inlinksEl, inlinks, 'Inlinks');
                    this.setupHoverPreview(this.outlinksEl, [...outlinks, ...canvasLinks], 'Outlinks');
                }
    
                this.toggleDetailedView(view, file);
                this.adjustLayout_insideExpandedDetailedView(viewHeader, viewHeaderTitle);
            });
    
            document.addEventListener('click', this.handleClickOutside);
        } catch (error) {
            console.error('Error updating link navigator:', error);
            requestAnimationFrame(() => {
                if (this.inlinksEl && this.outlinksEl) {
                    this.inlinksEl.textContent = 'INLINKS (0)';
                    this.outlinksEl.textContent = 'OUTLINKS (0)';
                    // Still show elements even if there are no links
                    this.inlinksEl.classList.add('link-navigator-visible');
                    this.outlinksEl.classList.add('link-navigator-visible');
                }
            });
        }
    }

    // 1.1 CLeanup the DOM before rendering anything, and nullify: inlinksEl, outlinksEl, detailsEl
    //     This prevents duplicate elements and ensures that the UI is updated cleanly.
    removeLinkNavigation() {
        if (this.inlinksEl) this.inlinksEl.remove();
        if (this.outlinksEl) this.outlinksEl.remove();
        if (this.detailsEl) this.detailsEl.remove();
        this.inlinksEl = null;
        this.outlinksEl = null;
        this.detailsEl = null;
    }

    // 1.2 Store inlinks and outlinks of a file in the cache
    private async cacheLinkData(file: TFile): Promise<CacheEntry> {
        const cacheKey = file.path;
        
        if (this.cache.has(cacheKey) && !this.dirtyCache.has(cacheKey)) {
            const cachedEntry = this.cache.get(cacheKey);
            if (cachedEntry && Date.now() - cachedEntry.timestamp < this.settings.cacheTimeout) {
                return cachedEntry;
            }
        }
    
        if (this.loadingPromises.has(cacheKey)) {
            return this.loadingPromises.get(cacheKey) ?? this.getLinks(file);
        }
    
        const loadingPromise = this.getLinks(file);
        this.loadingPromises.set(cacheKey, loadingPromise);
    
        try {
            const result = await Promise.race([
                loadingPromise,
                new Promise<never>((_, reject) => 
                    setTimeout(() => reject(new Error('Loading timeout')), 10000)
                )
            ]);
    
            this.cache.set(cacheKey, { ...result, timestamp: Date.now() });
            this.loadingPromises.delete(cacheKey);
    
            if (this.cache.size > this.maxCacheSize) {
                const oldestKey = Array.from(this.cache.entries())
                    .sort(([, a], [, b]) => a.timestamp - b.timestamp)[0]?.[0];
                if (oldestKey) this.cache.delete(oldestKey);
            }
    
            return result;
        } catch (error) {
            this.loadingPromises.delete(cacheKey);
            throw error;
        }
    }

    // 1.3 Get Links 
    private async getLinks(file: TFile): Promise<CacheEntry> {
        const inlinks = new Set<string>();
        const outlinks = new Set<string>();
        const canvasLinks = new Set<string>();
    
        // Use Obsidian API to get inlinks
        const resolvedLinks = this.app.metadataCache.resolvedLinks;
        for (const [sourcePath, targetLinks] of Object.entries(resolvedLinks)) {
            if (targetLinks[file.path]) {
                const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
                if (sourceFile instanceof TFile) {
                    inlinks.add(sourceFile.basename);
                }
            }
        }
    
        // Use Obsidian API to get outlinks
        const fileCache = this.app.metadataCache.getFileCache(file);
        if (fileCache) {
            // Check links in the main content
            if (fileCache.links) {
                for (const link of fileCache.links) {
                    const linkedFile = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
                    if (linkedFile instanceof TFile) {
                        if (linkedFile.extension === 'canvas') {
                            canvasLinks.add(linkedFile.basename);
                        } else {
                            outlinks.add(linkedFile.basename);
                        }
                    }
                }
            }
    
            // Check links in the frontmatter
            if (fileCache.frontmatter) {
                const frontmatterContent = JSON.stringify(fileCache.frontmatter);
                const frontmatterLinks = frontmatterContent.match(/\[\[([^\]]+)\]\]/g) || [];
                for (const link of frontmatterLinks) {
                    const cleanLink = link.slice(2, -2).split('|')[0];
                    const linkedFile = this.app.metadataCache.getFirstLinkpathDest(cleanLink, file.path);
                    if (linkedFile instanceof TFile) {
                        if (linkedFile.extension === 'canvas') {
                            canvasLinks.add(linkedFile.basename);
                        } else {
                            outlinks.add(linkedFile.basename);
                        }
                    }
                }
            }
        }
    
        // If searchCanvasLinks is enabled, search Canvas files for links to this file
        if (this.settings.searchCanvasLinks) {
            const canvasFiles = this.app.vault.getFiles().filter(f => f.extension === 'canvas');
            for (const canvasFile of canvasFiles) {
                const content = await this.app.vault.read(canvasFile);
                const escapedFileName = file.basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const linkRegex = new RegExp(`\\[\\[${escapedFileName}(\\|.*?)?\\]\\]`, 'g');
                if (linkRegex.test(content)) {
                    canvasLinks.add(canvasFile.basename);
                }
            }
        }

        return { 
            inlinks: Array.from(inlinks), 
            outlinks: Array.from(outlinks), 
            canvasLinks: Array.from(canvasLinks),
            timestamp: Date.now() 
        };
    }

    // 2. Allow user to hover over the LinkNavigation and get a preview
    setupHoverPreview(element: HTMLElement, links: string[], title: string) {
        if (links.length === 0) return; // Don't set up hover preview for empty links
    
        let hoverTimeout: TimeoutId;
        let menu: Menu | null = null;
        
        element.addEventListener('mouseenter', (event) => {
            if (!this.isDetailsVisible) {
                hoverTimeout = setTimeout(() => {
                    menu = new Menu();
                    menu.addItem((item) => item.setTitle(title).setDisabled(true));
                    links.forEach(link => {
                        menu?.addItem((item) => 
                            item.setTitle(link).onClick(() => {
                                const targetFile = this.app.metadataCache.getFirstLinkpathDest(link, '/');
                                if (targetFile) {
                                    this.app.workspace.openLinkText(link, '/', false);
                                }
                            })
                        );
                    });
                    menu.showAtMouseEvent(event);
                }, 900);
            }
        });
    
        element.addEventListener('mouseleave', () => {
            clearTimeout(hoverTimeout);
            if (menu) {
                menu.hide();
            }
        });
    }

    // 3. Allow user click on "<- INLINKS" or "OUTLINKS ->" in LinkNavigation to expand and show
    // DetailedView and Render it
    private toggleDetailedView(view: MarkdownView, file: TFile) {
        if (this.detailsEl) {
            this.detailsEl.remove();
        }
        this.detailsEl = view.containerEl.createEl('div', { cls: 'link-navigator-details-wrapper' });
        const detailsInner = this.detailsEl.createEl('div', { cls: 'link-navigator-details' });
        detailsInner.classList.add('hidden');
        
        view.containerEl.querySelector('.view-header')?.after(this.detailsEl);
    
        const toggleDetails = async (e: MouseEvent) => {
            e.stopPropagation();
            this.isDetailsVisible = !this.isDetailsVisible;
            if (this.isDetailsVisible) {
                detailsInner.classList.remove('hidden');
                detailsInner.classList.add('visible');
                await this.renderDetailedView(detailsInner, file);
            } else {
                detailsInner.classList.remove('visible');
                if (!this.isDetailsVisible) {
                    detailsInner.classList.add('hidden');
                }
            }
        };
        
        // Only add event listeners if there are links
        if (this.inlinksEl && this.inlinksEl.style.display !== 'none') {
            this.inlinksEl.addEventListener('click', toggleDetails);
        }
        if (this.outlinksEl && this.outlinksEl.style.display !== 'none') {
            this.outlinksEl.addEventListener('click', toggleDetails);
        }
    }
    
    
    

    // 3.1 Render DetailedView elements: Depth, Refresh button, Canvas Links toggle button.
    //     And fill it with inlinks, backlinks, canvas links information
    async renderDetailedView(containerEl: HTMLElement, file: TFile) {
        containerEl.empty();

        const controlsEl = containerEl.createDiv('link-navigator-controls');

        // Depth control and buttons wrapper
        const depthAndButtonsWrapper = controlsEl.createDiv('depth-and-buttons-wrapper');

        // Depth control
        const depthControlEl = depthAndButtonsWrapper.createDiv('depth-control');
        depthControlEl.createSpan({ text: 'Depth: ' });
        this.depthInput = new TextComponent(depthControlEl)
            .setValue(this.maxDepth.toString())
            .setPlaceholder('Enter depth')
            .onChange(async (value) => {
                const newDepth = parseInt(value);
                if (!isNaN(newDepth) && newDepth > 0) {
                    this.maxDepth = newDepth;
                    await this.updateDetailedViewContent(containerEl, file);
                }
            });
    
        const buttonContainer = depthAndButtonsWrapper.createDiv('button-container');
    
        // Add refresh button
        new ButtonComponent(buttonContainer)
            .setIcon('refresh-cw')
            .setTooltip('Refresh links')
            .onClick(() => {
                this.cache.delete(file.path);
                this.updateLinkNavigation(file);
            });
    
        // Canvas Links toggle
        const canvasLinksToggle = new ButtonComponent(buttonContainer)
            .setButtonText('Canvas Links')
            .setClass('canvas-links-toggle')
            .onClick(async () => {
                this.showCanvasLinks = !this.showCanvasLinks;
                canvasLinksToggle.buttonEl.classList.toggle('active');
                this.settings.showCanvasLinks = this.showCanvasLinks;
                await this.saveSettings();

                // Re-render the entire detailed view
                this.updateDetailedViewContent(containerEl, file);
            });

        if (this.showCanvasLinks) {
            canvasLinksToggle.buttonEl.classList.add('active');
        }
    
        containerEl.createDiv('link-navigator-content');
    
        // Add Outlinks of Inlinks toggle button
        const outlinksOfInlinksToggle = new ButtonComponent(buttonContainer)
            .setIcon('git-branch')
            .setTooltip('Toggle Outlinks of Inlinks')
            .onClick(() => {
                this.outlinksOfInlinksVisible = !this.outlinksOfInlinksVisible;
                outlinksOfInlinksToggle.buttonEl.classList.toggle('active');
                const inlinkOutlinks = document.querySelectorAll('.inlink-outlinks');
                inlinkOutlinks.forEach(el => el.classList.toggle('hidden', !this.outlinksOfInlinksVisible));
                // Re-render the entire detailed view
                this.updateDetailedViewContent(containerEl, file);
            });

        if (this.outlinksOfInlinksVisible) {
            outlinksOfInlinksToggle.buttonEl.classList.add('active');
        }

        // Initial content render
        await this.updateDetailedViewContent(containerEl, file);

    }

    // 3.2 Create a div where to show all found infromation
    private async updateDetailedViewContent(containerEl: HTMLElement, file: TFile) {
        const contentEl = containerEl.querySelector('.link-navigator-content');
        if (!contentEl) return;
    
        contentEl.empty();
    
        const hierarchyEl = contentEl.createDiv('link-hierarchy');
        await this.renderLinkHierarchy(hierarchyEl, file);
        
    }

    // 3.3 Create unordered list for each found link:
    //     - Inlinks will be rendered iteratively
    //     - Outlinks will be rendered recursively
    //     - Canvas Links will be rendered recursively (and allow to follow it up)
    private async renderLinkHierarchy(containerEl: HTMLElement, file: TFile) {
        containerEl.empty();
        const hierarchyUl = containerEl.createEl('ul');
    
        const cacheEntry = await this.cacheLinkData(file);
    
        // Render inlinks and get the depth at which they end
        const inlinksDepth = await this.renderInlinksIterativelyWithOutlinks(file, hierarchyUl, this.maxDepth);
    
        // Calculate the indent for the current note based on the inlinks depth
        // const currentNoteIndent = inlinksDepth * 20; // Assuming 20px indent per level
    
        // Render current note with the calculated indent
        const indentLevel = inlinksDepth;
        const currentLi = hierarchyUl.createEl('li', { 
            cls: `current-note indent-${indentLevel}` 
        });
        currentLi.createEl('span', { text: '\u00A0\u00A0\u00A0 •\u00A0\u00A0' });
        currentLi.createEl('strong', { text: file.basename });
    
        // Render outlinks
        const outlinksUl = currentLi.createEl('ul', { cls: 'outlinks-list' });
        // Always render at least one level of outlinks, but respect the max depth
        const outlinksDepth = Math.max(1, this.maxDepth - inlinksDepth);
        await this.renderOutlinksIteratively(file, outlinksUl, outlinksDepth);
    
        // Render Canvas links
        if (this.showCanvasLinks && cacheEntry.canvasLinks.length > 0) {
            this.renderCanvasLinks(hierarchyUl, cacheEntry.canvasLinks);
        }
    }
    
    // 3.3.1 Search for Inlinks: top-down approach
    // async renderInlinksIteratively(file: TFile, parentEl: HTMLElement, maxDepth: number) {
    //     const inlinkMap = new Map<string, { depth: number; file: TFile }>();
    //     const stack: { file: TFile; depth: number }[] = [{ file, depth: 0 }];
    //     const processedLinks: Set<string> = new Set();
    
    //     while (stack.length > 0) {
    //         const popped = stack.pop();
    //         if (!popped) continue;
    //         const { file: currentFile, depth } = popped;
            
    //         if (depth >= maxDepth || processedLinks.has(currentFile.path)) {
    //             continue;
    //         }
    
    //         processedLinks.add(currentFile.path);
    //         const cacheEntry = await this.cacheLinkData(currentFile);
    //         for (const inlink of cacheEntry.inlinks) {
    //             const sourceFile = this.app.metadataCache.getFirstLinkpathDest(inlink, '/');
    //             if (sourceFile instanceof TFile && !processedLinks.has(sourceFile.path)) {
    //                 const existingEntry = inlinkMap.get(sourceFile.path);
    //                 if (!existingEntry || existingEntry.depth > depth + 1) {
    //                     inlinkMap.set(sourceFile.path, { depth: depth + 1, file: sourceFile });
    //                     stack.push({ file: sourceFile, depth: depth + 1 });
    //                 }
    //             }
    //         }
    //     }
    
    //     // The deepest inlinks (those furthest from the current note in the link chain) appear at the top.
    //     // As you go down the list, you'll see inlinks that are progressively closer to the current note.
    //     // The shallowest inlinks (those directly linking to the current note) will appear at the bottom of the list.
    //     const sortedInlinks = Array.from(inlinkMap.entries()).sort((a, b) => b[1].depth - a[1].depth);
    
    //     // Find the maximum depth
    //     const maxFoundDepth = Math.max(...sortedInlinks.map(([, { depth }]) => depth));

    //     for (const [, { depth, file: sourceFile }] of sortedInlinks) {
    //         const li = parentEl.createEl('li', { cls: 'inlink' });
            
    //         // Calculate indent: deeper inlinks (at the top) have smaller indents
    //         const indent = (maxFoundDepth - depth) * 20;
    //         li.style.marginLeft = `${indent}px`;

    //         // Create a span for the arrow and add some right margin
    //         const arrowSpan = li.createEl('span', { text: '← ', cls: 'inlink-arrow' });
    //         arrowSpan.style.marginRight = '5px';

    //         const link = li.createEl('a', { text: sourceFile.basename, cls: 'internal-link' });
    //         link.addEventListener('click', (e) => {
    //             e.preventDefault();
    //             this.app.workspace.getLeaf().openFile(sourceFile);
    //         });
    //     }
    // }
    // Search for Inlinks first, the outlinks of those inlinks
    async renderInlinksIterativelyWithOutlinks(file: TFile, parentEl: HTMLElement, maxDepth: number): Promise<number> {
        const inlinkQueue: { file: TFile; depth: number }[] = [{ file, depth: 0 }];
        const inlinkMap = new Map<string, { depth: number; file: TFile; outlinks: string[] }>();
        const processedLinks: Set<string> = new Set();
        let maxInlinkDepth = 0;
    
        while (inlinkQueue.length > 0) {
            const current = inlinkQueue.shift();
            if (!current) continue;
            const { file: currentFile, depth } = current;
            
            if (depth >= maxDepth || processedLinks.has(currentFile.path)) {
                continue;
            }
    
            processedLinks.add(currentFile.path);
            const cacheEntry = await this.cacheLinkData(currentFile);
            for (const inlink of cacheEntry.inlinks) {
                const sourceFile = this.app.metadataCache.getFirstLinkpathDest(inlink, '/');
                if (sourceFile instanceof TFile && !processedLinks.has(sourceFile.path)) {
                    const inlinkCacheEntry = await this.cacheLinkData(sourceFile);
                    inlinkMap.set(sourceFile.path, { 
                        depth: depth + 1, 
                        file: sourceFile, 
                        outlinks: inlinkCacheEntry.outlinks 
                    });
                    inlinkQueue.push({ file: sourceFile, depth: depth + 1 });
                    maxInlinkDepth = Math.max(maxInlinkDepth, depth + 1);
                }
            }
        }
    
        const sortedInlinks = Array.from(inlinkMap.entries()).sort((a, b) => b[1].depth - a[1].depth);
        const maxFoundDepth = Math.max(...sortedInlinks.map(([, { depth }]) => depth));
    
        for (const [, { depth, file: sourceFile, outlinks }] of sortedInlinks) {
            const indent = maxFoundDepth - depth;
            const li = parentEl.createEl('li', { 
                cls: `inlink inlink-indent-${indent}`
            });
    
            li.createEl('span', { text: '← ', cls: 'inlink-arrow' });

            const link = li.createEl('a', { text: sourceFile.basename, cls: 'internal-link' });
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.app.workspace.getLeaf().openFile(sourceFile);
            });
    
            // Add outlinks (initially hidden)
            if (outlinks.length > 0) {
                const outlinksUl = li.createEl('ul', { cls: 'inlink-outlinks' });
                if (!this.outlinksOfInlinksVisible) {
                    outlinksUl.addClass('hidden');
                }
                for (const outlink of outlinks) {
                    const outLi = outlinksUl.createEl('li');
                    outLi.createEl('span', { text: '→ ' });
                    const outLink = outLi.createEl('a', { text: outlink, cls: 'internal-link' });
                    outLink.addEventListener('click', (e) => {
                        e.preventDefault();
                        const outlinkFile = this.app.metadataCache.getFirstLinkpathDest(outlink, '/');
                        if (outlinkFile instanceof TFile) {
                            this.app.workspace.getLeaf().openFile(outlinkFile);
                        }
                    });
                }
            }
        }
    
        return maxInlinkDepth; // Return the maximum depth of inlinks
    }

    // 3.3.2 Search for Outlinks and create indents (from fileCache, frontmatter & links in Canvas) 
    // async renderOutlinksRecursively(file: TFile, parentEl: HTMLElement, depth: number, processedLinks: Set<string>) {
    //     if (depth <= 0 || file.extension === 'canvas') return;
    
    //     const cacheEntry = await this.cacheLinkData(file);
    
    //     for (const outlink of cacheEntry.outlinks) {
    //         const linkedFile = this.app.metadataCache.getFirstLinkpathDest(outlink, file.path);
    //         if (linkedFile instanceof TFile && !processedLinks.has(linkedFile.path)) {
    //             processedLinks.add(linkedFile.path);
    //             const li = parentEl.createEl('li', { cls: 'outlink' });
    //             li.createEl('span', { text: '→ ' });
    //             const link = li.createEl('a', { text: linkedFile.basename, cls: 'internal-link' });
    //             link.addEventListener('click', (e) => {
    //                 e.preventDefault();
    //                 this.app.workspace.getLeaf().openFile(linkedFile);
    //             });
    //             const subUl = li.createEl('ul');
    //             await this.renderOutlinksRecursively(linkedFile, subUl, depth - 1, processedLinks);
    //         }
    //     }
    // }
    // 
    async renderOutlinksIteratively(file: TFile, parentEl: HTMLElement, maxDepth: number) {
        const queue: { file: TFile; depth: number; element: HTMLElement }[] = [{ file, depth: 0, element: parentEl }];
        const processedLinks: Set<string> = new Set();
    
        while (queue.length > 0) {
            const current = queue.shift();
            if (!current) continue;
            const { file: currentFile, depth, element: currentEl } = current;
    
            if (depth >= maxDepth || currentFile.extension === 'canvas' || processedLinks.has(currentFile.path)) {
                continue;
            }
    
            processedLinks.add(currentFile.path);
            const cacheEntry = await this.cacheLinkData(currentFile);
    
            if (cacheEntry.outlinks.length > 0) {
                const outlinksUl = currentEl.createEl('ul', { cls: 'outlink-outlinks' });
    
                for (const outlink of cacheEntry.outlinks) {
                    const linkedFile = this.app.metadataCache.getFirstLinkpathDest(outlink, currentFile.path);
                    if (linkedFile instanceof TFile && !processedLinks.has(linkedFile.path)) {
                    const li = outlinksUl.createEl('li', { cls: `outlink outlink-depth-${depth}` });
                        
                        li.createEl('span', { text: '→ ' });
                        const link = li.createEl('a', { text: linkedFile.basename, cls: 'internal-link' });
                        link.addEventListener('click', (e) => {
                            e.preventDefault();
                            this.app.workspace.getLeaf().openFile(linkedFile);
                        });
                        queue.push({ file: linkedFile, depth: depth + 1, element: li });
                    }
                }
            }
        }
    }

    // 3.3.3 Render Canvas Links
    private renderCanvasLinks(parentEl: HTMLElement, canvasLinks: string[]) {
        const canvasLi = parentEl.createEl('li', { cls: 'canvas-links' });
        canvasLi.createEl('strong', { text: 'Canvas Links' });
        const canvasUl = canvasLi.createEl('ul');
        canvasLinks.forEach(link => {
            const li = canvasUl.createEl('li');
            const linkEl = li.createEl('a', { text: link, cls: 'internal-link' });
            linkEl.addEventListener('click', (e) => {
                e.preventDefault();
                const canvasFile = this.app.vault.getAbstractFileByPath(`${link}.canvas`);
                if (canvasFile instanceof TFile) {
                    this.app.workspace.getLeaf().openFile(canvasFile);
                } else {
                    new Notice(`Canvas file not found: ${link}`);
                }
            });
        });
    }

    // 4. Adjust DetailedView window size depending on how small it is
    adjustLayout_insideExpandedDetailedView(viewHeader: Element, viewHeaderTitle: Element) {
        const headerRect = viewHeader.getBoundingClientRect();
        const titleRect = viewHeaderTitle.getBoundingClientRect();
        const availableWidth = headerRect.width;
        const titleWidth = titleRect.width;
        const inlinksWidth = this.inlinksEl?.offsetWidth || 0;
        const outlinksWidth = this.outlinksEl?.offsetWidth || 0;
    
        const totalWidth = inlinksWidth + titleWidth + outlinksWidth;
        const isCompact = totalWidth > availableWidth * 0.9; // 90% threshold
    
        viewHeader.classList.toggle('link-navigator-compact', isCompact);
    }

    // 5. Collapse DetailedView. This method will check if the click occurred 
    // outside the detailed view. If so, it will collapse the detailed view.
    private handleClickOutside = (event: MouseEvent) => {
        if (this.detailsEl && this.isDetailsVisible) {
            const target = event.target as HTMLElement;
            const detailsInner = this.detailsEl.querySelector('.link-navigator-details');
            if (detailsInner instanceof HTMLElement && 
                !detailsInner.contains(target) && 
                !this.inlinksEl?.contains(target) && 
                !this.outlinksEl?.contains(target)) {
                detailsInner.classList.remove('visible');
                this.isDetailsVisible = false;

                if (!this.isDetailsVisible) {
                        detailsInner.classList.add('hidden');
                }
                
            }
        }
    };

    // 6. Cache cleanup setup. Ensures that only one interval is running at a time
    // and configures the interval duration based on settings.
    setupCacheCleanup() {
        // First clears any existing interval to avoid multiple intervals running simultaneously.
        if (this.cacheCleanupInterval !== null) {
            clearInterval(this.cacheCleanupInterval);
        }

        this.cacheCleanupInterval = setInterval(() => {
            this.cleanupCache();
        }, this.settings.cacheCleanupInterval * 60 * 1000);
    }

    // 6.1 Do the actual cleanup by removing expired entries
    private cleanupCache() {
        const now = Date.now();
        let entriesRemoved = 0;
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.settings.cacheTimeout) {
                this.cache.delete(key);
                entriesRemoved++;
            }
        }
        
        if (entriesRemoved > 0 && this.settings.showCacheCleanupNotice) {
            if (now - this.lastCleanupNotice > this.CLEANUP_NOTICE_COOLDOWN) {
                new Notice(`Cleaned up ${entriesRemoved} cache entries.`);
                this.lastCleanupNotice = now;
            }
        }
    }
    // EXTRA:

    // Show cache status via the button in the settings
    showCacheStatus() {
        const cacheSize = this.cache.size;
        const cacheTimeout = this.settings.cacheTimeout / 60000; // Convert to minutes

        if (cacheSize === 0) {
            new Notice("Cache is empty.");
            return;
        }

        const cacheEntries = Array.from(this.cache.entries());
        if (cacheEntries.length > 0) {
            const oldestEntry = cacheEntries.sort(([, a], [, b]) => a.timestamp - b.timestamp)[0][1];
            const newestEntry = cacheEntries.sort(([, a], [, b]) => b.timestamp - a.timestamp)[0][1];

            const message = `Cache Size: ${cacheSize} entries\n`
                + `Cache Timeout: ${cacheTimeout} minutes\n`
                + `Oldest Entry: ${oldestEntry?.timestamp ? new Date(oldestEntry.timestamp).toLocaleString() : 'N/A'}\n`
                + `Newest Entry: ${newestEntry?.timestamp ? new Date(newestEntry.timestamp).toLocaleString() : 'N/A'}\n`
                + `Dirty Cache Entries: ${this.dirtyCache.size}`;

            new Notice(message);
        } else {
            new Notice("Cache is empty.");
        }
    }

    // Allow user to rebuild cache in the settings
    rebuildCache() {
        // Clear the existing cache
        this.cache.clear();
        this.dirtyCache.clear();
        this.loadingPromises.clear();

        // Get all the files in the vault
        const files = this.app.vault.getFiles();

        // Trigger an update for each file to rebuild the cache
        for (const file of files) {
            this.updateLinkNavigation(file);
        }

        new Notice("Cache has been rebuilt.");
    }

    private invalidateCache(file: TFile) {
        this.cache.delete(file.path);
        this.dirtyCache.add(file.path);
    }

    private debouncedUpdateLinkNavigation = debounce(async (file: TFile, forceRefresh: boolean) =>
        this.updateLinkNavigation(file),
        800,
        true
    );
}

class LinkNavigationSettingTab extends PluginSettingTab {
    plugin: LinkNavigationPlugin;

    constructor(app: App, plugin: LinkNavigationPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Search Canvas Links')
            .setDesc('Enable or disable searching for links in Canvas files')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.searchCanvasLinks)
                .onChange(async (value) => {
                    this.plugin.settings.searchCanvasLinks = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Cache Timeout')
            .setDesc('Time (in minutes) before cached data is considered stale')
            .addText(text => text
                .setPlaceholder('Enter cache timeout')
                .setValue((this.plugin.settings.cacheTimeout / 60000).toString())
                .onChange(async (value) => {
                    const timeout = parseInt(value) * 60000;
                    if (!isNaN(timeout) && timeout > 0) {
                        this.plugin.settings.cacheTimeout = timeout;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Cache Cleanup Interval')
            .setDesc('Set the interval (in minutes) for cleaning up the cache')
            .addText(text => text
                .setPlaceholder('Enter cache cleanup interval (minutes)')
                .setValue(this.plugin.settings.cacheCleanupInterval.toString())
                .onChange(async (value) => {
                    const interval = parseInt(value);
                    if (!isNaN(interval) && interval > 0) {
                        this.plugin.settings.cacheCleanupInterval = interval;
                        await this.plugin.saveSettings();
                        this.plugin.setupCacheCleanup();
                    }
                })
            );

        new Setting(containerEl)
            .setName('Cache Status')
            .setDesc('Display the current cache status')
            .addButton((btn) => {
                btn.setButtonText('Show Cache Status')
                    .onClick(() => {
                        this.plugin.showCacheStatus();
                    });
            });
            
        new Setting(containerEl)
            .setName('Rebuild Cache')
            .setDesc('Manually rebuild the cache')
            .addButton((btn) => {
                btn.setButtonText('Rebuild Cache')
                    .onClick(() => {
                        this.plugin.rebuildCache();
                    });
            });
        new Setting(containerEl)
            .setName('Show Cache Cleanup Notice')
            .setDesc('Display a notice when the cache is being cleaned up')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showCacheCleanupNotice)
                .onChange(async (value) => {
                    this.plugin.settings.showCacheCleanupNotice = value;
                    await this.plugin.saveSettings();
                }));
    }
}