# Internal Link Navigation Plugin for Obsidian

![image](https://github.com/user-attachments/assets/25f57e8f-e3ae-4925-b41c-6206845504ae)

https://github.com/user-attachments/assets/54048449-3e42-4a07-8a86-0772b81a51e4

This plugin helps you navigate back and forth between your links from current note `N` levels deep.


## Features

- Hierarchical view of links*
- Show links from Canvas files
- Depth Control for Link Hierarchies: Allows users to define how deep the plugin should traverse the link hierarchy (e.g., links of links).
- Caching Mechanism


## Background

0. Speed. In the past I used custom DatviewJS queries, to navigate notes. However, it usually took around 120-170ms for each query to process + a few extra seconds for rendering to finish. This plugin loads in 2-15ms, and all your links are near instantly always available.

1. I don't use folders. I embedd all of my notes inside one another and navigate via connections: either via graph, back/forward buttons, search, or simply via contextual navigation. However sometimes, certain internal links are deeply within the note structure, or sometimes I open certain note from within the search e.g. "Note C", and then wanna quickly navigate to a 'MOC" note where it was embedded 2 notes back e.g.: "Note A" (back buttons are not available, because I opened it directly from the search; which meeans I would need to either search for that note, that's including if I even remember its name, navigate to it via the graph, or navigate via "Backlinks" core plugin 1 page a time).  

2. By default Obsidian doesn't show Links coming from Canvas. So if you have embedded certain note somewhere in the Canvas, or have mentioned it, or have written topic related to that one particular note - it can be very difficult to know where exactly (it is possible, in particular with smaller vault sizes, however it gets cumbersome when topics gets interconnected spanning multiple domains and it makes it really hard to track down in which Canvas file certain file was embedded).  

Thus it helps by allowing you to:  

- Navigate up and down your note connections, as deep as you want
- See links from Canvas files, so you don't miss those connections
- Quickly jump between related notes, even if they're not directly linked
- Find your way back to important notes (like MOCs) without remembering exact titles or clicking endlessly



## How to use:

The plugin simply allows to navigate between links in your note. 

1. Install the plugin
2. Open any new note which has links embedded e.g.: in the below example my current note has 2 links 

    - ![image](https://github.com/user-attachments/assets/ba294f42-ad14-4ac9-9c18-835905a7c502)


3. At the top of each note, you'll see two new elements INLINKS & OUTLINKS (you can customize it and have it as any other text, ICON or color) which you can click on to see Detailed Link View. This view shows a hierarchy of links related to your current note.
  
    - ← INLINKS (X): Shows how many notes link to the current note.
    - OUTLINKS (Y) →: Shows how many links are in the current note.
    - ![image](https://github.com/user-attachments/assets/3891a8de-f49a-44f0-8b36-60e5ea8d3900)
    - Or in a graph it would look something like this: 
    ![image](https://github.com/user-attachments/assets/4b9037d0-d659-4275-933a-67ef8957f7a4)

4. You can specify how deep you see the link connections by adjusting "Depth".

   - ![image](https://github.com/user-attachments/assets/d8a23e04-d588-4b4a-a631-b0d49ef693be)
   - Or in graph view it would appear like this:
   ![image](https://github.com/user-attachments/assets/28552300-3968-44ae-bd56-b8907254c85d)


5. For instance if you would like to see what link are inside Note 1 or Note 2, from within the note you are currently in - then, you can toggle the "Toggle outlinks of inlinks" button:
    - ![image](https://github.com/user-attachments/assets/fd8216f4-a921-4e86-bf25-119de9d343d2)
    - This allows you to to open Links which were embedded inside previous notes but without actually needing to navigate via them. As you can simply Click on any link in the detailed view to open that note or Use Cmd/Ctrl + Click to open a link in a new tab.
    - For instance in the screenshot, we could click on "Note1-1" to open it directly, without needing to go the long route via "Note1" and only then to "Note1-1"


6. Some other features:
    - Refresh button: Click this to update the link data if you've made recent changes.
    - Canvas Links Toggle: Turn this on/off to show/hide links from Canvas files.
    - Outlinks of Inlinks Toggle: This shows you what other notes your inlinks link to.
    - Hover Preview: Hover over the "INLINKS" or "OUTLINKS" text (without expanding the detailed view) to see a quick list of linked notes.


Hope this explains things a little. 

---

*Links - it mainly deals with internal link:
- Resolved links: Links to notes that actually exist in your vault.
- Incoming links (or inlinks): links to the active note
- Outgoing links (or outlinks): links from the active note
- Frontmatter links: Any links found in the frontmatter section of your notes.
- Canvas links - if current note is embbed anywhere in any of the Canvas files it will locate them

