import { App, Menu, Notice, Plugin, PluginSettingTab, Setting, debounce, TFile, MarkdownView, ButtonComponent, TextComponent, Modal, getIcon, getIconIds, setIcon } from 'obsidian';

interface LinkNavigationSettings {
    isCanvasLinksEnabled: boolean; // Controls visibility of the toggle button
    isAttachmentsEnabled: boolean; // Controls visibility of the toggle button
    isTagsEnabled: boolean; // Controls visibility of the toggle button
    toggleCanvasLinks?: boolean;    // State of the canvas links toggle
    toggleAttachments?: boolean;   // State of the attachments toggle
    toggleTags?: boolean;          // State of the tags toggle

    cacheTimeout: number;
    showCacheCleanupNotice: boolean;
    cacheCleanupInterval: number;
    inlinkFormat: string;
    outlinkFormat: string;
    showInlinkCount: boolean;
    showOutlinkCount: boolean;
    inlinkText: string;
    outlinkText: string;
    inlinkArrow: string;
    outlinkArrow: string;
    inlinkCustomClass: string;
    outlinkCustomClass: string;
    inlinkIcon: string;
    outlinkIcon: string;
}

type TimeoutId = ReturnType<typeof setTimeout>;

const DEFAULT_SETTINGS: LinkNavigationSettings = {
    isCanvasLinksEnabled: true,
    isAttachmentsEnabled: true,
    isTagsEnabled: true,
    toggleCanvasLinks: undefined,  // Initially undefined
    toggleAttachments: undefined, // Initially undefined
    toggleTags: undefined,       // Initially undefined

    cacheTimeout: 5 * 60 * 1000, // 5 minutes
    cacheCleanupInterval: 5, // 5 minutes
    showCacheCleanupNotice: true,
    inlinkFormat: "{arrow} {label} ({count})",
    outlinkFormat: "{label} ({count}) {arrow}",
    showInlinkCount: true,
    showOutlinkCount: true,
    inlinkText: "INLINKS",
    outlinkText: "OUTLINKS",
    inlinkArrow: "←",
    outlinkArrow: "→",
    inlinkCustomClass: "",
    outlinkCustomClass: "",
    inlinkIcon: "arrow-left-circle",  // Default inlink icon
    outlinkIcon: "arrow-right-circle", // Default outlink icon
}

interface CacheEntry {
    inlinks: string[];
    outlinks: string[];
    canvasLinks: string[];
    attachments: string[];
    tags: string[];
    timestamp: number;
}
class IconPickerModal extends Modal {
    private plugin: LinkNavigationPlugin;
    private settingKey: 'inlinkIcon' | 'outlinkIcon';
    private iconInput: TextComponent;
    private iconList: HTMLElement; // Reference to the icon list container
    private searchInput: TextComponent;

    constructor(app: App, plugin: LinkNavigationPlugin, settingKey: 'inlinkIcon' | 'outlinkIcon', iconInput: TextComponent) {
        super(app);
        this.plugin = plugin;
        this.settingKey = settingKey;
        this.iconInput = iconInput;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Select a Lucide Icon' });

        this.searchInput = new TextComponent(contentEl)
            .setPlaceholder('Search for icons...');
        this.searchInput.inputEl.style.width = '100%';
        this.searchInput.onChange(debounce(() => {
            this.updateIconList(this.searchInput.getValue());
        }, 50, false));

        this.iconList = contentEl.createEl('div', { cls: 'icon-picker-list' });
        this.iconList.style.overflowY = 'scroll';
        this.iconList.style.maxHeight = '300px';
        this.iconList.style.border = '1px solid var(--background-modifier-border)';

        // Initial empty list (or a loading indicator)
        this.updateIconList("");
    }


    updateIconList(filter: string) {
        requestAnimationFrame(() => {
            this.iconList.empty(); // Clear previous results

            const filterLower = filter.toLowerCase();
            const allIconIds = getIconIds();
            const filteredIcons = allIconIds.filter(id => id.toLowerCase().includes(filterLower));

            if (filteredIcons.length === 0 && filter !== "") {
                this.iconList.createEl('div', { text: 'No icons found.', cls: 'icon-picker-item' });
            } else {
                filteredIcons.forEach(iconId => {
                    const iconItem = this.iconList.createEl('div', { cls: 'icon-picker-item' });
                    iconItem.style.display = 'flex';
                    iconItem.style.alignItems = 'center';
                    iconItem.style.padding = '5px';
                    iconItem.style.cursor = 'pointer';

                    const iconEl = iconItem.createEl('span', { cls: 'icon-picker-icon' });
                    iconEl.style.marginRight = '10px';
                    setIcon(iconEl, iconId);

                    iconItem.createEl('span', { text: iconId });

                    // Corrected: Use this.registerDomEvent (within the modal)
                    this.plugin.registerDomEvent(iconItem, 'click', () => {
                        this.plugin.settings[this.settingKey] = iconId;
                        this.plugin.saveSettings();
                        this.iconInput.setValue(iconId);
                        this.close();
                    });
                });
            }
        });
    }


    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
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
    private toggleCanvasLinks = true; // Tracks the *state* of the Canvas Links toggle
    private outlinksOfInlinksVisible = false;
    private shouldShowDetailedView = false;
    private toggleAttachments = true; // Tracks the *state* of the Attachments toggle
    private toggleTags = false; // Tracks the *state* of the Tags toggle

    // Add Cache
    private cache: Map<string, CacheEntry> = new Map();
    private loadingPromises: Map<string, Promise<CacheEntry>> = new Map();
    private maxCacheSize = 200; // Adjust based on performance and memory usage
    private dirtyCache: Set<string> = new Set();
    showCacheCleanupNotice: true;
    private cacheCleanupInterval: TimeoutId | null = null;
    private lastCleanupNotice = 0;
    private readonly CLEANUP_NOTICE_COOLDOWN = 5000; // 5 seconds cooldown
    inlinkIconTextComponent: TextComponent | null = null;
    outlinkIconTextComponent: TextComponent | null = null;

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new LinkNavigationSettingTab(this.app, this));

        // Load saved toggle states correctly.  Use settings directly.
        this.toggleCanvasLinks = this.settings.toggleCanvasLinks ?? this.settings.isCanvasLinksEnabled;
        this.toggleAttachments = this.settings.toggleAttachments ?? this.settings.isAttachmentsEnabled;
        this.toggleTags = this.settings.toggleTags ?? this.settings.isTagsEnabled;

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
            name: 'Force refresh link navigation',
            callback: () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                    this.updateLinkNavigation(activeFile, true);
                }
            }
        });

        this.addCommand({
            id: 'toggle-link-navigation-detailed-view',
            name: 'Toggle link navigation detailed view',
            callback: () => {
                const activeFile = this.app.workspace.getActiveFile();
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (activeFile && view) {
                    this.toggleDetailedView(view, activeFile);
                }
            }
        });

        document.addEventListener('keydown', this.handleEscapeKey);

        this.setupCacheCleanup();
    }


    onunload() {
        this.removeLinkNavigation();
        document.removeEventListener('click', this.handleClickOutside);
        // Clears Cache and Promises
        this.cache.clear();
        this.loadingPromises.clear();
        this.dirtyCache.clear();
        this.shouldShowDetailedView = false;

        document.removeEventListener('keydown', this.handleEscapeKey);

        // Remove periodic cache cleanup interval
        if (this.cacheCleanupInterval !== null) {
            clearInterval(this.cacheCleanupInterval);
            this.cacheCleanupInterval = null;
        }

    }

    async loadSettings() {
        // Load settings and merge with defaults
        const loadedSettings = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);

        // Ensure toggle states are loaded if they exist, otherwise use is...Enabled as fallback
        this.settings.toggleCanvasLinks = loadedSettings?.toggleCanvasLinks ?? DEFAULT_SETTINGS.isCanvasLinksEnabled;
        this.settings.toggleAttachments = loadedSettings?.toggleAttachments ?? DEFAULT_SETTINGS.isAttachmentsEnabled;
        this.settings.toggleTags = loadedSettings?.toggleTags ?? DEFAULT_SETTINGS.isTagsEnabled;
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async updateSettings(updates: Partial<LinkNavigationSettings>) {
        Object.assign(this.settings, updates);
        await this.saveSettings();
    }


    // Helper function to format the link text
    formatLinkText(format: string, label: string, count: number, arrow: string, showCount: boolean, iconId: string): string {
        let text = format.replace("{label}", label);
        text = text.replace("{arrow}", arrow);

        if (format.includes("{icon}")) {
            if (getIcon(iconId)) {
                // Create the icon span *within* formatLinkText
                const iconSpan = `<span class="link-navigator-icon">${getIcon(iconId)!.outerHTML}</span>`;
                text = text.replace("{icon}", iconSpan);
            } else {
                console.warn(`Link Navigator: Invalid icon ID: ${iconId}`);
                text = text.replace("{icon}", '<span class="link-navigator-icon">�</span>'); // Placeholder
            }
        } else {
            text = text.replace("{icon}", ""); // Remove placeholder if not used
        }

        text = showCount ? text.replace("{count}", count.toString()) : text.replace(/(\(|\)|\[|\]|\{|\})?\s*\{count\}\s*(\(|\)|\[|\]|\{|\})?/, "");
        return text;
    }


    async updateLinkNavigation(file: TFile, forceRefresh = false) {
        if (forceRefresh) {
            this.invalidateCache(file);
        }

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !(view instanceof MarkdownView)) return;

        const viewHeader = view.containerEl.querySelector('.view-header');
        const viewContent = view.containerEl.querySelector('.view-content');
        if (!viewHeader || !viewContent) return;

        const viewHeaderTitle = viewHeader.querySelector('.view-header-title');
        if (!viewHeaderTitle) return;

        this.removeLinkNavigation();

        // Create elements
        this.inlinksEl = document.createElement('div');
        this.outlinksEl = document.createElement('div');
        this.inlinksEl.classList.add('link-navigator-inlinks', 'link-navigator-visible');
        this.outlinksEl.classList.add('link-navigator-outlinks', 'link-navigator-visible');

        // Apply custom classes, if any
        if (this.settings.inlinkCustomClass) {
            this.inlinksEl.classList.add(...this.settings.inlinkCustomClass.split(" ").filter(Boolean));
        }
        if (this.settings.outlinkCustomClass) {
            this.outlinksEl.classList.add(...this.settings.outlinkCustomClass.split(" ").filter(Boolean));
        }

        // Create mobile container
        const mobileContainer = document.createElement('div');
        mobileContainer.classList.add('mobile-link-navigator');
        const mobileInlinksEl = this.inlinksEl.cloneNode(true) as HTMLElement;
        const mobileOutlinksEl = this.outlinksEl.cloneNode(true) as HTMLElement;
        mobileContainer.appendChild(mobileInlinksEl);
        mobileContainer.appendChild(mobileOutlinksEl);


        // Add to both desktop and mobile locations
        viewHeaderTitle.before(this.inlinksEl);
        viewHeaderTitle.after(this.outlinksEl);
        viewContent.prepend(mobileContainer);

        try {
            const { inlinks, outlinks, canvasLinks } = await this.cacheLinkData(file);

            requestAnimationFrame(() => {
                if (this.inlinksEl && this.outlinksEl) {
                    const totalOutlinks = outlinks.length + canvasLinks.length;

                    const updateText = (el: HTMLElement) => {
                        if (el.classList.contains('link-navigator-inlinks')) {
                            el.innerHTML = this.formatLinkText(
                                this.settings.inlinkFormat,
                                this.settings.inlinkText,
                                inlinks.length,
                                this.settings.inlinkArrow,
                                this.settings.showInlinkCount,
                                this.settings.inlinkIcon // Pass the icon ID
                            );
                        } else if (el.classList.contains('link-navigator-outlinks')) {
                            el.innerHTML = this.formatLinkText(
                                this.settings.outlinkFormat,
                                this.settings.outlinkText,
                                totalOutlinks,
                                this.settings.outlinkArrow,
                                this.settings.showOutlinkCount,
                                this.settings.outlinkIcon  // Pass the icon ID
                            );
                        }
                    };

                    // Update both desktop and mobile elements
                    updateText(this.inlinksEl);
                    updateText(this.outlinksEl);
                    updateText(mobileInlinksEl);
                    updateText(mobileOutlinksEl);


                    this.setupHoverPreview(this.inlinksEl, inlinks, 'Inlinks');
                    this.setupHoverPreview(this.outlinksEl, [...outlinks, ...canvasLinks], 'Outlinks');

                    // Setup hover for mobile elements too
                    this.setupHoverPreview(mobileInlinksEl, inlinks, 'Inlinks');
                    this.setupHoverPreview(mobileOutlinksEl, [...outlinks, ...canvasLinks], 'Outlinks');

                    if (this.shouldShowDetailedView) {
                        this.toggleDetailedView(view, file);
                    }

                    this.updateDetailedViewState(view, file);
                    this.adjustLayout_insideExpandedDetailedView(viewHeader, viewHeaderTitle);
                }
                this.adjustLayout_insideExpandedDetailedView(viewHeader, viewHeaderTitle);

            });

            document.addEventListener('click', this.handleClickOutside);
        } catch (error) {
            console.error('Error updating link navigator:', error);
        }
    }

    // 1.1 CLeanup the DOM before rendering anything, and nullify: inlinksEl, outlinksEl, detailsEl
    //     This prevents duplicate elements and ensures that the UI is updated cleanly.
    removeLinkNavigation() {
        if (this.inlinksEl) this.inlinksEl.remove();
        if (this.outlinksEl) this.outlinksEl.remove();
        if (this.detailsEl) this.detailsEl.remove();

        // Remove mobile container if it exists
        const mobileContainer = document.querySelector('.mobile-link-navigator');
        if (mobileContainer) mobileContainer.remove();

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
        const attachments = new Set<string>();
        const tags = new Set<string>();

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
                    this.addLinkToAppropriateSet(link.link, outlinks, canvasLinks);
                }
            }

            // Check embedded links in the main content
            if (fileCache.embeds) {
                for (const embed of fileCache.embeds) {
                    this.addLinkToAppropriateSet(embed.link, outlinks, canvasLinks);
                }
            }

            // Check links and embeds in the frontmatter
            if (fileCache.frontmatter) {
                const frontmatterContent = JSON.stringify(fileCache.frontmatter);
                const allLinks = frontmatterContent.match(/(?:\[\[([^\]]+)\]\])|(?:!\[\[([^\]]+)\]\])/g) || [];
                for (const link of allLinks) {
                    const cleanLink = link.replace(/^!?\[\[|\]\]$/g, '').split('|')[0];
                    this.addLinkToAppropriateSet(cleanLink, outlinks, canvasLinks);
                }
            }
        }

        // If searchCanvasLinks is enabled, search Canvas files for links to this file
        if (this.settings.isCanvasLinksEnabled) {
            const canvasFiles = this.app.vault.getFiles().filter(f => f.extension === 'canvas');
            for (const canvasFile of canvasFiles) {
                const content = await this.app.vault.read(canvasFile);
                const escapedFileName = file.basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const linkRegex = new RegExp(`(?:\\[\\[${escapedFileName}(?:#[^\\]]+)?(?:\\|.*?)?\\]\\])|(?:!\\[\\[${escapedFileName}(?:#[^\\]]+)?(?:\\|.*?)?\\]\\])`, 'g');
                if (linkRegex.test(content)) {
                    canvasLinks.add(canvasFile.basename);
                }
            }
        }

        // Define a regex pattern for all supported file types
        const supportedExtensions = [
            // Images
            'avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp', 'tif', 'tiff', 'psd', 'dng', 'heif', 'heic', 'cr2', 'nef', 'ico',

            // Audio
            'flac', 'm4a', 'mp3', 'ogg', 'wav', 'webm', '3gp',

            // Video
            'mkv', 'mov', 'mp4', 'ogv', 'avi',

            // Documents
            'pdf', 'doc', 'docx', 'xlsx', 'pptx', 'djvu', 'epub',

            // Archives
            'zip', '7z', 'tar', 'gz', 'rar', 'xc', 'bzip2', 'iso', 'cmg', 'msi',

            // Programming
            'py', 'js', 'ts', 'html', 'css', 'json', 'xml', 'java', 'cpp', 'cs', 'rb', 'php', 'swift', 'go', 'rs', 'sh'
        ].join('|');

        const attachmentRegex = new RegExp(`!?\\[\\[([^\\]]+\\.(?:${supportedExtensions}))\\]\\]`, 'gi');


        // Check for attachments in embeds
        if (fileCache && fileCache.embeds) {
            for (const embed of fileCache.embeds) {
                const attachmentFile = this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
                if (attachmentFile instanceof TFile) {
                    const ext = attachmentFile.extension.toLowerCase();
                    if (ext !== 'md' && ext !== 'canvas') {
                        attachments.add(attachmentFile.basename + '.' + attachmentFile.extension);
                    }
                }
            }
        }

        // Check for attachments in the main content
        const content = await this.app.vault.read(file);
        let match;
        while ((match = attachmentRegex.exec(content)) !== null) {
            attachments.add(match[1]);
        }

        // Get tags from the file
        if (fileCache) {
            if (fileCache.tags) {
                fileCache.tags.forEach(tag => tags.add(tag.tag));
            }
            // Check for tags in the frontmatter
            if (fileCache.frontmatter && fileCache.frontmatter.tags) {
                if (Array.isArray(fileCache.frontmatter.tags)) {
                    fileCache.frontmatter.tags.forEach((tag: string) => tags.add(tag));
                } else if (typeof fileCache.frontmatter.tags === 'string') {
                    tags.add(fileCache.frontmatter.tags);
                }
            }
        }

        return {
            inlinks: Array.from(inlinks),
            outlinks: Array.from(outlinks),
            canvasLinks: Array.from(canvasLinks),
            attachments: Array.from(attachments),
            tags: Array.from(tags),
            timestamp: Date.now()
        };
    }

    // 1.4
    private addLinkToAppropriateSet(link: string, outlinks: Set<string>, canvasLinks: Set<string>) {
        // Remove any header information from the link
        const linkWithoutHeader = link.split('#')[0];

        const linkedFile = this.app.metadataCache.getFirstLinkpathDest(linkWithoutHeader, '');
        if (linkedFile instanceof TFile) {
            if (linkedFile.extension === 'canvas') {
                canvasLinks.add(linkedFile.basename);
            } else {
                outlinks.add(linkedFile.basename);
            }
        }
    }

    // 1.5
    private renderAttachments(parentEl: HTMLElement, attachments: string[]) {
        if (!this.toggleAttachments || attachments.length === 0) return; // Use toggle state

        const attachmentsUl = parentEl.createEl('ul', { cls: 'attachments-list' });
        attachments.forEach(attachment => {
            const li = attachmentsUl.createEl('li', { cls: 'attachment' });
            const ext = attachment.split('.').pop()?.toLowerCase();
            let icon = '📎';

            const iconMap: { [key: string]: string } = {
                // Images
                'avif': '🖼️', 'bmp': '🖼️', 'gif': '🖼️', 'jpeg': '🖼️', 'jpg': '🖼️', 'png': '🖼️', 'svg': '🖼️', 'webp': '🖼️',
                'tif': '🖼️', 'tiff': '🖼️', 'psd': '🖼️', 'dng': '🖼️', 'heif': '🖼️', 'heic': '🖼️', 'cr2': '🖼️', 'nef': '🖼️', 'ico': '🖼️',

                // Audio
                'flac': '🎵', 'm4a': '🎵', 'mp3': '🎵', 'ogg': '🎵', 'wav': '🎵', '3gp': '🎵',

                // Video
                'mkv': '🎥', 'mov': '🎥', 'mp4': '🎥', 'ogv': '🎥', 'webm': '🎥', 'avi': '🎥',

                // Documents
                'pdf': '📄', 'doc': '📄', 'docx': '📄', 'xlsx': '📊', 'pptx': '📊', 'djvu': '📚', 'epub': '📚',

                // Archives
                'zip': '🗜️', '7z': '🗜️', 'tar': '🗜️', 'gz': '🗜️', 'rar': '🗜️', 'xc': '🗜️', 'bzip2': '🗜️', 'iso': '💿', 'cmg': '💿', 'msi': '💿',

                // Programming (single icon for all)
                'py': '💻', 'js': '💻', 'ts': '💻', 'html': '💻', 'css': '💻', 'json': '💻', 'xml': '💻', 'java': '💻', 'cpp': '💻', 'cs': '💻',
                'rb': '💻', 'php': '💻', 'swift': '💻', 'go': '💻', 'rs': '💻', 'sh': '💻'
            };

            if (ext && ext in iconMap) {
                icon = iconMap[ext];
            }

            li.createEl('span', { text: `${icon} `, cls: 'attachment-icon' });
            const attachmentLink = li.createEl('a', { text: attachment, cls: 'internal-link' });
            attachmentLink.addEventListener('click', (e) => {
                e.preventDefault();
                const attachmentFile = this.app.metadataCache.getFirstLinkpathDest(attachment, '/');
                if (attachmentFile instanceof TFile) {
                    this.app.workspace.getLeaf().openFile(attachmentFile);
                }
            });
        });

    }

    // 1.6
    private renderTags(parentEl: HTMLElement, tags: string[]) {
        if (!this.toggleTags || tags.length === 0) return;  // Use toggle state

        const tagsContainer = parentEl.createEl('div', { cls: 'link-navigator-tags' });
        tags.forEach(tag => {
            const tagEl = tagsContainer.createEl('div', { cls: 'tag', text: `${tag}` });
            tagEl.addEventListener('click', (e) => {
                e.preventDefault();
                this.app.workspace.openLinkText(`#${tag}`, '', true);
            });
        });
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
    // handle both desktop and mobile clicks:
    public toggleDetailedView(view: MarkdownView, file: TFile) {
        if (this.shouldShowDetailedView || this.detailsEl?.querySelector('.link-navigator-details')?.classList.contains('visible')) {
            this.shouldShowDetailedView = false;
        } else {
            this.shouldShowDetailedView = true;
        }
        this.updateDetailedViewState(view, file);
    }

    public updateDetailedViewState(view: MarkdownView, file: TFile) {
        if (!this.detailsEl) {
            this.detailsEl = view.containerEl.createEl('div', { cls: 'link-navigator-details-wrapper' });
            const detailsInner = this.detailsEl.createEl('div', { cls: 'link-navigator-details' });
            detailsInner.classList.add('hidden');
            view.containerEl.querySelector('.view-content')?.prepend(this.detailsEl);
        }

        const detailsInner = this.detailsEl.querySelector('.link-navigator-details') as HTMLElement;

        if (this.shouldShowDetailedView) {
            detailsInner.classList.remove('hidden');
            detailsInner.classList.add('visible');
            this.renderDetailedView(detailsInner, file);
        } else {
            detailsInner.classList.remove('visible');
            detailsInner.classList.add('hidden');
        }

        this.updateClickHandlers(view);

    }


    // 3.0.1
    private updateClickHandlers(view: MarkdownView) {
        const addClickHandler = (element: HTMLElement | null) => {
            if (element && element.style.display !== 'none') {
                element.removeEventListener('click', this.toggleDetailedViewHandler);
                element.addEventListener('click', this.toggleDetailedViewHandler);
            }
        };

        addClickHandler(this.inlinksEl);
        addClickHandler(this.outlinksEl);

        const mobileContainer = view.containerEl.querySelector('.mobile-link-navigator');
        if (mobileContainer) {
            const mobileInlinks = mobileContainer.querySelector('.link-navigator-inlinks');
            const mobileOutlinks = mobileContainer.querySelector('.link-navigator-outlinks');
            if (mobileInlinks instanceof HTMLElement) addClickHandler(mobileInlinks);
            if (mobileOutlinks instanceof HTMLElement) addClickHandler(mobileOutlinks);
        }
    }

    // 3.0.2
    private toggleDetailedViewHandler = (e: MouseEvent) => {
        e.stopPropagation();
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const file = this.app.workspace.getActiveFile();
        if (view && file) {
            this.toggleDetailedView(view, file);
        }
    };

    // 3.0.3
    private handleEscapeKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && this.shouldShowDetailedView) {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            const file = this.app.workspace.getActiveFile();
            if (view && file) {
                this.toggleDetailedView(view, file);
            }
        }
    };

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

        // Canvas Links toggle (use isCanvasLinksEnabled for visibility, toggleCanvasLinks for state)
        if (this.settings.isCanvasLinksEnabled) {
            const canvasLinksToggle = new ButtonComponent(buttonContainer)
                .setButtonText('Canvas links')
                .setClass('canvas-links-toggle')
                .onClick(async () => {
                    this.toggleCanvasLinks = !this.toggleCanvasLinks;
                    canvasLinksToggle.buttonEl.classList.toggle('active', this.toggleCanvasLinks);
                    await this.updateSettings({ toggleCanvasLinks: this.toggleCanvasLinks }); // SAVE STATE
                    this.updateDetailedViewContent(containerEl, file);
                });

            canvasLinksToggle.buttonEl.classList.toggle('active', this.toggleCanvasLinks);
        }

        containerEl.createDiv('link-navigator-content');

        // Add Outlinks of Inlinks toggle button
        const outlinksOfInlinksToggle = new ButtonComponent(buttonContainer)
            .setIcon('git-branch')
            .setTooltip('Toggle outlinks of inlinks')
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

        // Attachments toggle (use isAttachmentsEnabled for visibility, toggleAttachments for state)
        if (this.settings.isAttachmentsEnabled) {
            const attachmentsToggle = new ButtonComponent(buttonContainer)
                .setIcon('paperclip')
                .setTooltip('Toggle attachments')
                .onClick(async () => {
                    this.toggleAttachments = !this.toggleAttachments;
                    attachmentsToggle.buttonEl.classList.toggle('active', this.toggleAttachments);
                    await this.updateSettings({ toggleAttachments: this.toggleAttachments }); // SAVE STATE
                    this.updateDetailedViewContent(containerEl, file);
                });

            attachmentsToggle.buttonEl.classList.toggle('active', this.toggleAttachments);
        }

        // Add Tags toggle (use isTagsEnabled for visibility, toggleTags for state)
        if (this.settings.isTagsEnabled) {
            const tagsToggle = new ButtonComponent(buttonContainer)
                .setIcon('tag')
                .setTooltip('Toggle tags')
                .onClick(async () => {
                    this.toggleTags = !this.toggleTags;
                    tagsToggle.buttonEl.classList.toggle('active', this.toggleTags);
                    await this.updateSettings({ toggleTags: this.toggleTags }); // SAVE STATE
                    this.updateDetailedViewContent(containerEl, file);
                });

            tagsToggle.buttonEl.classList.toggle('active', this.toggleTags);
        }
        // Initial content render
        await this.updateDetailedViewContent(containerEl, file);

    }

    // 3.2 Create a div where to show all found infromation
    private async updateDetailedViewContent(containerEl: HTMLElement, file: TFile) {
        const contentEl = containerEl.querySelector('.link-navigator-content');
        if (!contentEl || !(contentEl instanceof HTMLElement)) return;

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

        // Render current note
        const indentLevel = inlinksDepth;
        const currentLi = hierarchyUl.createEl('li', {
            cls: `current-note indent-${indentLevel}`
        });
        currentLi.createEl('span', { text: '\u00A0\u00A0\u00A0 •\u00A0\u00A0' }); //Consistent Indentation
        currentLi.createEl('strong', { text: file.basename });

        // Add tags for current note
        if (this.toggleTags && cacheEntry.tags.length > 0) { // Use toggle state
            const currentNoteCacheEntry = await this.cacheLinkData(file);
            this.renderTags(currentLi, currentNoteCacheEntry.tags);
        }

        // Render outlinks
        const outlinksUl = currentLi.createEl('ul', { cls: 'outlinks-list' });
        const outlinksDepth = Math.max(1, this.maxDepth - inlinksDepth);
        await this.renderOutlinksIteratively(file, outlinksUl, outlinksDepth);

        // Render Canvas links
        if (this.toggleCanvasLinks && cacheEntry.canvasLinks.length > 0) { // Use toggle state
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
            link.addEventListener('click', async (e) => {
                e.preventDefault();
                if (e.metaKey || e.ctrlKey) {
                    await this.openInNewLeaf(sourceFile);
                } else {
                    this.app.workspace.getLeaf().openFile(sourceFile);
                }
            });

            // Add tags for inlinks
            if (this.toggleTags) {  // Use toggle state
                const inlinkCacheEntry = await this.cacheLinkData(sourceFile);
                this.renderTags(li, inlinkCacheEntry.tags);
            }

            // Create a container for attachments
            const attachmentsContainer = li.createEl('div', { cls: 'inlink-attachments' });
            // Render attachments for the inlink itself
            // Render attachments for the inlink
            if (this.toggleAttachments) { // Use toggle state
                const inlinkCacheEntry = await this.cacheLinkData(sourceFile);
                await this.renderAttachmentsForOutlink(sourceFile, attachmentsContainer, inlinkCacheEntry.attachments);
            }

            // Add outlinks (initially hidden)
            if (outlinks.length > 0 || (this.toggleAttachments && sourceFile)) { // Use toggle state
                const outlinksUl = li.createEl('ul', { cls: 'inlink-outlinks' });
                if (!this.outlinksOfInlinksVisible) {
                    outlinksUl.addClass('hidden');
                }
                for (const outlink of outlinks) {
                    const outlinkFile = this.app.metadataCache.getFirstLinkpathDest(outlink, '/');
                    if (outlinkFile instanceof TFile && outlinkFile.extension === 'md') {
                        const outLi = outlinksUl.createEl('li');
                        outLi.createEl('span', { text: '→ ' });
                        const outLink = outLi.createEl('a', { text: outlink, cls: 'internal-link' });
                        outLink.addEventListener('click', async (e) => {
                            e.preventDefault();
                            if (e.metaKey || e.ctrlKey) {
                                await this.openInNewLeaf(outlinkFile);
                            } else {
                                this.app.workspace.getLeaf().openFile(outlinkFile);
                            }
                        });

                        // Add tags for outlinks of inlinks
                        if (this.toggleTags) { // Use toggle state
                            const outlinkCacheEntry = await this.cacheLinkData(outlinkFile);
                            this.renderTags(outLi, outlinkCacheEntry.tags);
                        }
                    }
                }
            }
        }

        return maxInlinkDepth;
    }

    // 3.3.1.1 Helper method to add to the class to handle the CMD/Ctrl click behavior
    private async openInNewLeaf(file: TFile) {
        const leaf = this.app.workspace.getLeaf('tab');
        await leaf.openFile(file, { active: false });
    }

    private async renderAttachmentsForOutlink(file: TFile, parentEl: HTMLElement, attachments: string[]) {
        if (!this.toggleAttachments || attachments.length === 0) return; // Use toggle state

        const attachmentsUl = parentEl.createEl('ul', { cls: 'outlink-attachments' });
        for (const attachment of attachments) {
            const li = attachmentsUl.createEl('li');
            li.createEl('span', { text: '📎 ' });
            const attachmentLink = li.createEl('a', { text: attachment, cls: 'internal-link' });
            attachmentLink.addEventListener('click', async (e) => {
                e.preventDefault();
                const attachmentFile = this.app.metadataCache.getFirstLinkpathDest(attachment, file.path);
                if (attachmentFile instanceof TFile) {
                    if (e.metaKey || e.ctrlKey) {
                        await this.openInNewLeaf(attachmentFile);
                    } else {
                        this.app.workspace.getLeaf().openFile(attachmentFile);
                    }
                }
            });
        }
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
        const processedAttachments: Map<string, Set<string>> = new Map();

        while (queue.length > 0) {
            const current = queue.shift();
            if (!current) continue;
            const { file: currentFile, depth, element: currentEl } = current;

            if (depth >= maxDepth || currentFile.extension === 'canvas' || processedLinks.has(currentFile.path)) {
                continue;
            }

            processedLinks.add(currentFile.path);
            const cacheEntry = await this.cacheLinkData(currentFile);

            if (cacheEntry.outlinks.length > 0 || (this.toggleAttachments && cacheEntry.attachments.length > 0)) { // Use toggle state
                const outlinksUl = currentEl.createEl('ul', { cls: 'outlink-outlinks' });

                // Render attachments for the current outlink
                if (this.toggleAttachments) { // Use toggle state
                    const newAttachments = this.getNewAttachments(currentFile.path, cacheEntry.attachments, processedAttachments);
                    if (newAttachments.length > 0) {
                        this.renderAttachments(outlinksUl, newAttachments);
                    }
                }

                for (const outlink of cacheEntry.outlinks) {
                    const linkedFile = this.app.metadataCache.getFirstLinkpathDest(outlink, currentFile.path);
                    if (linkedFile instanceof TFile && !processedLinks.has(linkedFile.path)) {
                        const li = outlinksUl.createEl('li', { cls: `outlink outlink-depth-${depth}` });

                        li.createEl('span', { text: '→ ' });
                        const link = li.createEl('a', { text: linkedFile.basename, cls: 'internal-link' });

                        // Render tags if showTags is true
                        if (this.toggleTags) { // Use toggle state
                            const outlinkCacheEntry = await this.cacheLinkData(linkedFile);
                            this.renderTags(li, outlinkCacheEntry.tags);
                        }

                        link.addEventListener('click', async (e) => {
                            e.preventDefault();
                            if (e.metaKey || e.ctrlKey) {
                                await this.openInNewLeaf(linkedFile);
                            } else {
                                this.app.workspace.getLeaf().openFile(linkedFile);
                            }
                        });

                        // Render attachments for this outlink (outlink of outlink)
                        if (this.toggleAttachments) { // Use toggle state
                            const outlinkCacheEntry = await this.cacheLinkData(linkedFile);
                            const newAttachments = this.getNewAttachments(linkedFile.path, outlinkCacheEntry.attachments, processedAttachments);
                            if (newAttachments.length > 0) {
                                const attachmentsContainer = li.createEl('div', { cls: 'outlink-attachments' });
                                this.renderAttachments(attachmentsContainer, newAttachments);
                            }
                        }

                        queue.push({ file: linkedFile, depth: depth + 1, element: li });
                    }
                }
            }
        }
    }

    private getNewAttachments(filePath: string, attachments: string[], processedAttachments: Map<string, Set<string>>): string[] {
        if (!processedAttachments.has(filePath)) {
            processedAttachments.set(filePath, new Set());
        }
        const fileProcessedAttachments = processedAttachments.get(filePath)!;

        const newAttachments = attachments.filter(attachment => !fileProcessedAttachments.has(attachment));
        newAttachments.forEach(attachment => fileProcessedAttachments.add(attachment));

        return newAttachments;
    }

    // 3.3.3 Render Canvas Links
    private renderCanvasLinks(parentEl: HTMLElement, canvasLinks: string[]) {
        const canvasLi = parentEl.createEl('li', { cls: 'canvas-links' });
        canvasLi.createEl('strong', { text: 'Canvas links' });
        const canvasUl = canvasLi.createEl('ul');
        canvasLinks.forEach(async (link) => {
            const li = canvasUl.createEl('li');
            const linkEl = li.createEl('a', { text: link, cls: 'internal-link' });
            linkEl.addEventListener('click', async (e) => {
                e.preventDefault();
                // Try different path variations to find the canvas file
                let canvasFile = this.app.metadataCache.getFirstLinkpathDest(`${link}.canvas`, '/');

                if (!canvasFile) {
                    // Try finding it by normalized path
                    const files = this.app.vault.getFiles().filter(f =>
                        f.extension === 'canvas' &&
                        f.basename.toLowerCase() === link.toLowerCase()
                    );

                    if (files.length > 0) {
                        canvasFile = files[0];
                    }
                }

                if (canvasFile instanceof TFile) {
                    if (e.metaKey || e.ctrlKey) {
                        await this.openInNewLeaf(canvasFile);
                    } else {
                        this.app.workspace.getLeaf().openFile(canvasFile);
                    }
                } else {
                    // Provide more detailed error message
                    new Notice(`Canvas file not found: ${link}\nTried paths:\n- ${link}.canvas`);
                    console.error('Canvas file not found. Link:', link, 'Available canvas files:',
                        this.app.vault.getFiles().filter(f => f.extension === 'canvas').map(f => f.path));
                }


                if (canvasFile instanceof TFile) {
                    const cacheEntry = await this.cacheLinkData(canvasFile);
                    this.renderAttachments(li, cacheEntry.attachments);
                }

                if (this.toggleTags && canvasFile instanceof TFile) {  // Use toggle state
                    const canvasCacheEntry = await this.cacheLinkData(canvasFile);
                    this.renderTags(li, canvasCacheEntry.tags);
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
        if (this.detailsEl && this.shouldShowDetailedView) {
            const target = event.target as HTMLElement;
            const detailsInner = this.detailsEl.querySelector('.link-navigator-details');
            if (detailsInner instanceof HTMLElement &&
                !detailsInner.contains(target) &&
                !this.inlinksEl?.contains(target) &&
                !this.outlinksEl?.contains(target)) {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                const file = this.app.workspace.getActiveFile();
                if (view && file) {
                    this.toggleDetailedView(view, file);
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

            const message = `Cache size: ${cacheSize} entries\n`
                + `Cache timeout: ${cacheTimeout} minutes\n`
                + `Oldest entry: ${oldestEntry?.timestamp ? new Date(oldestEntry.timestamp).toLocaleString() : 'N/A'}\n`
                + `Newest entry: ${newestEntry?.timestamp ? new Date(newestEntry.timestamp).toLocaleString() : 'N/A'}\n`
                + `Dirty cache entries: ${this.dirtyCache.size}`;

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

    updateDetailedView() {
        const activeFile = this.app.workspace.getActiveFile();
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeFile && view && this.detailsEl) {
            this.renderDetailedView(this.detailsEl, activeFile);
        }
    }
}

class LinkNavigationSettingTab extends PluginSettingTab {
    plugin: LinkNavigationPlugin;

    constructor(app: App, plugin: LinkNavigationPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Link Display Settings' });

        new Setting(containerEl)
            .setName('Inlink format')
            .setDesc('Format for inlink display. Use {label}, {count}, {arrow}, and {icon}. Example: "{arrow} {label} ({count})" might display as " ⇦ Inlinks (5)')
            .addText(text => text
                .setPlaceholder('{arrow} {label} ({count})')
                .setValue(this.plugin.settings.inlinkFormat)
                .onChange(async (value) => {
                    this.plugin.settings.inlinkFormat = value;
                    await this.plugin.saveSettings();
                }));

        // Inlink Icon Setting
        new Setting(containerEl)
            .setName('Inlink {icon}')
            .setDesc('Select a Lucide icon to represent inlinks.')
            .addText(text => {
                this.plugin.inlinkIconTextComponent = text; // Store the TextComponent
                text
                    .setPlaceholder('Icon ID')
                    .setValue(this.plugin.settings.inlinkIcon)
                    .onChange(async (value) => {
                        this.plugin.settings.inlinkIcon = value;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.setAttribute('data-setting-id', 'inlinkIcon');
            })
            .addButton(button => {
                button
                    .setIcon('search')
                    .setTooltip('Pick icon')
                    .onClick(() => {
                        if (this.plugin.inlinkIconTextComponent) {
                            new IconPickerModal(this.app, this.plugin, 'inlinkIcon', this.plugin.inlinkIconTextComponent).open();
                        } else {
                            console.error("Inlink Icon TextComponent is not initialized.");
                        }

                    });

            });
        new Setting(containerEl)

            .setName('Inlink {label}')
            .setDesc('Text for the inlink label (e.g., "Inlinks").')
            .addText(text => text
                .setPlaceholder('INLINKS')
                .setValue(this.plugin.settings.inlinkText)
                .onChange(async (value) => {
                    this.plugin.settings.inlinkText = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Inlink {arrow}')
            .setDesc('Character to use as the inlink arrow.')
            .addText(text => text
                .setPlaceholder('←')
                .setValue(this.plugin.settings.inlinkArrow)
                .onChange(async (value) => {
                    this.plugin.settings.inlinkArrow = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show inlink count')
            .setDesc('Display the number of inlinks.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showInlinkCount)
                .onChange(async (value) => {
                    this.plugin.settings.showInlinkCount = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Inlink custom CSS class")
            .setDesc("Add custom CSS classes to inlink elements (space separated). E.g.: `custom-inlink-class` then in your custom CSS snippet you could use this custom CLASS to further style you inlink. ")
            .addText(text => text
                .setPlaceholder("custom-inlink-class")
                .setValue(this.plugin.settings.inlinkCustomClass)
                .onChange(async (value) => {
                    this.plugin.settings.inlinkCustomClass = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Outlink format')
            .setDesc('Format for outlink display. Use {label}, {count}, {arrow}, and {icon}.')
            .addText(text => text
                .setPlaceholder('{label} ({count}) {arrow}')
                .setValue(this.plugin.settings.outlinkFormat)
                .onChange(async (value) => {
                    this.plugin.settings.outlinkFormat = value;
                    await this.plugin.saveSettings();
                }));


        // Outlink Icon Setting
        new Setting(containerEl)
            .setName('Outlink icon')
            .setDesc('Select a Lucide icon to represent outlinks.')
            .addText(text => {
                this.plugin.outlinkIconTextComponent = text;  // Store the TextComponent instance
                text
                    .setPlaceholder('Icon ID')
                    .setValue(this.plugin.settings.outlinkIcon)
                    .onChange(async (value) => {
                        this.plugin.settings.outlinkIcon = value;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.setAttribute('data-setting-id', 'outlinkIcon'); // Add this line!
            })
            .addButton(button => { // Use addButton on the Setting object
                button
                    .setIcon('search')
                    .setTooltip('Pick icon')
                    .onClick(() => {
                        if (this.plugin.outlinkIconTextComponent) {
                            new IconPickerModal(this.app, this.plugin, 'outlinkIcon', this.plugin.outlinkIconTextComponent).open();
                        } else {
                            console.error("Outlink Icon TextComponent is not initialized.");
                        }
                    });
            });

        new Setting(containerEl)  // Corrected: Moved Outlink Label setting *after* Outlink Icon
            .setName('Outlink label')
            .setDesc('Text for the outlink label (e.g., "Outlinks").')
            .addText(text => text
                .setPlaceholder('OUTLINKS')
                .setValue(this.plugin.settings.outlinkText)
                .onChange(async (value) => {
                    this.plugin.settings.outlinkText = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Outlink arrow')
            .setDesc('Character to use as the outlink arrow.')
            .addText(text => text
                .setPlaceholder('→')
                .setValue(this.plugin.settings.outlinkArrow)
                .onChange(async (value) => {
                    this.plugin.settings.outlinkArrow = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show outlink count')
            .setDesc('Display the number of outlinks.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showOutlinkCount)
                .onChange(async (value) => {
                    this.plugin.settings.showOutlinkCount = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Outlink custom CSS class")
            .setDesc("Add custom CSS classes to outlink elements (space separated). . E.g.: `custom-outlink-class` then in your custom CSS snippet you could use this custom CLASS to further style you outlink. ")
            .addText(text => text
                .setPlaceholder("custom-outlink-class")
                .setValue(this.plugin.settings.outlinkCustomClass)
                .onChange(async (value) => {
                    this.plugin.settings.outlinkCustomClass = value;
                    await this.plugin.saveSettings();
                })
            );

        containerEl.createEl('h2', { text: 'General Settings' });

        // Use isCanvasLinksEnabled for the setting
        new Setting(containerEl)
            .setName('Enable Canvas Links Toggle')
            .setDesc('Show the toggle button for Canvas links in the detailed view.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.isCanvasLinksEnabled)
                .onChange(async (value) => {
                    await this.plugin.updateSettings({ isCanvasLinksEnabled: value });
                }));

        // Use isAttachmentsEnabled for the setting
        new Setting(containerEl)
            .setName('Enable Attachments Toggle')
            .setDesc('Show the toggle button for attachments in the detailed view.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.isAttachmentsEnabled)
                .onChange(async (value) => {
                    await this.plugin.updateSettings({ isAttachmentsEnabled: value });
                }));

        // Use isTagsEnabled for the setting
        new Setting(containerEl)
            .setName('Enable Tags Toggle')
            .setDesc('Show the toggle button for tags in the detailed view.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.isTagsEnabled)
                .onChange(async (value) => {
                    await this.plugin.updateSettings({ isTagsEnabled: value });
                }));


        new Setting(containerEl)
            .setName('Cache timeout')
            .setDesc('How long (in minutes) to keep link data in the cache before refreshing.  Higher values reduce CPU usage but may show slightly outdated information.')
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
            .setName('Cache cleanup interval')
            .setDesc('How often (in minutes) to automatically clean up old entries in the cache.')
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
            .setName('Cache status')
            .setDesc('View the current size and status of the link cache.')
            .addButton((btn) => {
                btn.setButtonText('Show cache status')
                    .onClick(() => {
                        this.plugin.showCacheStatus();
                    });
            });

        new Setting(containerEl)
            .setName('Rebuild cache')
            .setDesc('Manually rebuild the link cache. This can be useful if you suspect the cache is corrupted or out of sync.')
            .addButton((btn) => {
                btn.setButtonText('Rebuild cache')
                    .onClick(() => {
                        this.plugin.rebuildCache();
                    });
            });
        new Setting(containerEl)
            .setName('Show cache cleanup notice')
            .setDesc('Display a brief notification when the cache is automatically cleaned.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showCacheCleanupNotice)
                .onChange(async (value) => {
                    this.plugin.settings.showCacheCleanupNotice = value;
                    await this.plugin.saveSettings();
                }));
    }
}