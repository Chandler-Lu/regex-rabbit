(function () {
  // Basic flag to trace if script has run at least once in this context
  if (window.regexSearchScriptHasRun) {
    // console.log("Regex Search script has run before in this context.");
  } else {
    // console.log("Regex Search script initializing context.");
    window.regexSearchScriptHasRun = true;
  }

  // --- Element References (will be populated by ensureUI) ---
  let searchContainer = null;
  let searchInput = null;
  let countDisplay = null;
  let prevButton = null;
  let nextButton = null;
  let closeButton = null;
  let caseToggleButton = null;
  let separatorElement = null;
  let navButtonWrapper = null;

  // --- State ---
  let matches = [];
  let currentIndex = -1;
  let currentRegex = null;
  let debounceTimer = null;
  let isVisible = false;
  let isCaseSensitive = false;

  // ---- UI Creation (Simplified: Creates if container ID not found) ----
  function createAndAppendUI() {
    // console.log("Attempting to create UI elements.");

    // --- Create Elements ---
    searchContainer = document.createElement("div");
    searchContainer.id = "regex-search-container"; // This ID is key
    searchContainer.className = "hidden";

    searchInput = document.createElement("input");
    searchInput.id = "regex-search-input";
    searchInput.type = "text";
    searchInput.placeholder = "Regex Search...";
    searchInput.spellcheck = false;
    searchInput.addEventListener("input", handleInput);
    searchInput.addEventListener("keydown", handleKeyDown);

    caseToggleButton = document.createElement("button");
    caseToggleButton.id = "regex-case-toggle";
    caseToggleButton.className = "regex-search-button";
    caseToggleButton.textContent = "Aa"; // Keep text for this one
    caseToggleButton.addEventListener("click", toggleCaseSensitivity);

    countDisplay = document.createElement("span");
    countDisplay.id = "regex-search-count";

    separatorElement = document.createElement("span");
    separatorElement.id = "regex-search-separator";

    navButtonWrapper = document.createElement("span");
    navButtonWrapper.id = "regex-nav-button-wrapper";
    navButtonWrapper.style.display = "inline-flex";
    navButtonWrapper.style.alignItems = "center";

    prevButton = document.createElement("button");
    prevButton.id = "regex-prev-button";
    prevButton.className = "regex-search-button icon-button";
    prevButton.title = "Previous match (Shift+Enter)";
    prevButton.textContent = ""; // <<< Explicitly empty
    prevButton.addEventListener("click", () => navigate(-1));

    nextButton = document.createElement("button");
    nextButton.id = "regex-next-button";
    nextButton.className = "regex-search-button icon-button";
    nextButton.title = "Next match (Enter)";
    nextButton.textContent = ""; // <<< Explicitly empty
    nextButton.addEventListener("click", () => navigate(1));

    navButtonWrapper.appendChild(prevButton);
    navButtonWrapper.appendChild(nextButton);

    closeButton = document.createElement("button");
    closeButton.id = "regex-close-button";
    closeButton.className = "regex-search-button icon-button";
    closeButton.title = "Close Search (Esc)";
    closeButton.textContent = ""; // <<< Explicitly empty
    closeButton.addEventListener("click", hideSearchUI);

    // --- Append Order ---
    searchContainer.appendChild(searchInput);
    searchContainer.appendChild(caseToggleButton);
    searchContainer.appendChild(countDisplay);
    searchContainer.appendChild(separatorElement);
    searchContainer.appendChild(navButtonWrapper);
    searchContainer.appendChild(closeButton);

    // --- Append to Body ---
    if (document.body) {
      document.body.appendChild(searchContainer);
      // console.log("UI appended to body.");
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        if (!document.getElementById("regex-search-container")) {
          // Check again
          document.body.appendChild(searchContainer);
          // console.log("UI appended to body after DOMContentLoaded.");
        }
      });
    }

    // Update visuals after creation
    updateCaseToggleVisuals();
    updateButtonStates(); // Set initial disabled state

    return true; // Indicate creation happened
  }

  // --- Get References (Simple query, assumes elements exist) ---
  function getUIReferences() {
    searchContainer = document.getElementById("regex-search-container");
    if (!searchContainer) return false;
    searchInput = document.getElementById("regex-search-input");
    caseToggleButton = document.getElementById("regex-case-toggle");
    countDisplay = document.getElementById("regex-search-count");
    separatorElement = document.getElementById("regex-search-separator");
    navButtonWrapper = document.getElementById("regex-nav-button-wrapper");
    prevButton = document.getElementById("regex-prev-button");
    nextButton = document.getElementById("regex-next-button");
    closeButton = document.getElementById("regex-close-button");
    return !!searchInput; // Basic check if input was found
  }

  // --- Ensure UI (Simplified: Create if needed, then get refs) ---
  function ensureUI() {
    if (!document.getElementById("regex-search-container")) {
      // console.log("Container not found, creating UI.");
      createAndAppendUI();
    } else if (!searchContainer || !searchInput) {
      // If container exists but refs are null
      // console.log("Container found, getting references.");
      getUIReferences();
    }
    // Always try to update visuals based on current state after ensuring UI exists
    updateCaseToggleVisuals();
    updateButtonStates();
  }

  // --- Show / Hide (Use ensureUI) ---
  function showSearchUI() {
    ensureUI(); // Make sure UI is created and refs are set
    if (!searchContainer) {
      console.error("Failed to create/find UI container.");
      return;
    }

    // console.log("Showing Search UI");
    searchContainer.classList.remove("hidden");
    isVisible = true;
    requestAnimationFrame(() => {
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    });
    document.addEventListener("keydown", handleGlobalKeydown, true);
    if (searchInput?.value) {
      performSearch(searchInput.value);
    } else {
      updateButtonStates();
    }
  }

  function hideSearchUI() {
    // No need to ensure UI exists to hide it, just check container ref
    if (!searchContainer || !isVisible) return;
    // console.log("Hiding Search UI");
    searchContainer.classList.add("hidden");
    isVisible = false;
    removeHighlights();
    if (searchInput) {
      searchInput.blur();
    }
    document.removeEventListener("keydown", handleGlobalKeydown, true);
  }

  // --- Global Keydown (Unchanged) ---
  function handleGlobalKeydown(event) {
    if (event.key === "Escape" && isVisible) {
      if (searchContainer?.contains(document.activeElement) || isVisible) {
        event.preventDefault();
        event.stopPropagation();
        hideSearchUI();
      }
    }
  }
  // --- Case Sensitivity (Unchanged) ---
  function toggleCaseSensitivity() {
    isCaseSensitive = !isCaseSensitive;
    updateCaseToggleVisuals();
    if (searchInput?.value) {
      performSearch(searchInput.value);
    }
  }
  function updateCaseToggleVisuals() {
    if (caseToggleButton) {
      caseToggleButton.classList.toggle("active", isCaseSensitive);
      updateCaseToggleTitle();
    }
  }
  function updateCaseToggleTitle() {
    if (caseToggleButton) {
      caseToggleButton.title = isCaseSensitive ? "Match Case (On)" : "Match Case (Off)";
    }
  }
  // --- Event Handlers (Unchanged) ---
  function handleInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (isVisible && searchInput) {
        performSearch(searchInput.value);
      }
    }, 300);
  }
  function handleKeyDown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (matches.length > 0) {
        if (event.shiftKey) navigate(-1);
        else navigate(1);
      } else if (searchInput?.value && !currentRegex) {
        performSearch(searchInput.value);
      }
    }
  }
  // --- Search Logic (Unchanged) ---
  function performSearch(pattern) {
    removeHighlights();
    if (!pattern) {
      updateCountDisplay();
      if (searchInput) searchInput.classList.remove("invalid");
      currentRegex = null;
      updateButtonStates();
      return;
    }
    let regex;
    let flags = "gu";
    if (!isCaseSensitive) {
      flags += "i";
    }
    try {
      regex = new RegExp(pattern, flags);
      if (searchInput) searchInput.classList.remove("invalid");
      currentRegex = regex;
    } catch (e) {
      updateCountDisplay("Invalid Regex");
      if (searchInput) searchInput.classList.add("invalid");
      currentRegex = null;
      updateButtonStates();
      return;
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        const parent = node.parentElement;
        if (
          !parent ||
          parent.closest('script, style, noscript, textarea, #regex-search-container, [contenteditable="true"]')
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    let nodesToProcess = [];
    while ((node = walker.nextNode())) {
      nodesToProcess.push(node);
    }
    matches = [];
    nodesToProcess.forEach((textNode) => {
      const text = textNode.nodeValue;
      let match;
      let lastIndex = 0;
      const parent = textNode.parentNode;
      if (!parent || !parent.isConnected) return;
      const fragment = document.createDocumentFragment();
      let foundMatchInNode = false;
      regex.lastIndex = 0;
      while ((match = regex.exec(text)) !== null) {
        foundMatchInNode = true;
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
        }
        if (match[0].length > 0) {
          const mark = document.createElement("mark");
          mark.className = "regex-search-highlight";
          mark.textContent = match[0];
          fragment.appendChild(mark);
          matches.push(mark);
        }
        lastIndex = regex.lastIndex;
        if (match[0].length === 0) {
          if (regex.lastIndex === match.index) regex.lastIndex++;
          if (lastIndex >= text.length) break;
        }
      }
      if (foundMatchInNode) {
        if (lastIndex < text.length) {
          fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
        }
        try {
          parent.replaceChild(fragment, textNode);
        } catch (e) {}
      }
    });
    currentIndex = matches.length > 0 ? 0 : -1;
    if (currentIndex !== -1) {
      highlightCurrent();
    }
    updateCountDisplay();
    updateButtonStates();
  }
  // --- Highlights (Unchanged) ---
  function removeHighlights() {
    for (let i = matches.length - 1; i >= 0; i--) {
      const mark = matches[i];
      const parent = mark.parentNode;
      if (mark?.isConnected && parent) {
        try {
          parent.replaceChild(document.createTextNode(mark.textContent), mark);
          parent.normalize();
        } catch (e) {}
      }
    }
    matches = [];
    currentIndex = -1;
    currentRegex = null;
    if (searchInput) searchInput.classList.remove("invalid");
    updateCountDisplay();
    updateButtonStates();
  }
  // --- Navigation (Unchanged) ---
  function navigate(direction) {
    if (matches.length <= 1) return;
    if (currentIndex >= 0 && currentIndex < matches.length) {
      matches[currentIndex]?.classList.remove("current");
    }
    currentIndex += direction;
    if (currentIndex < 0) {
      currentIndex = matches.length - 1;
    } else if (currentIndex >= matches.length) {
      currentIndex = 0;
    }
    highlightCurrent();
    updateCountDisplay();
  }
  function highlightCurrent() {
    if (currentIndex >= 0 && currentIndex < matches.length) {
      const currentMatch = matches[currentIndex];
      if (currentMatch?.isConnected) {
        currentMatch.classList.add("current");
        currentMatch.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      }
    }
  }
  // --- UI Updates (Unchanged) ---
  function updateButtonStates() {
    const enableNav = matches.length > 1;
    if (prevButton) prevButton.disabled = !enableNav;
    if (nextButton) nextButton.disabled = !enableNav;
  }
  function updateCountDisplay(message = null) {
    if (!countDisplay) return;
    if (message) {
      countDisplay.textContent = message;
    } else {
      const total = matches.length;
      countDisplay.textContent =
        searchInput?.value || total > 0 ? `${total === 0 ? 0 : currentIndex + 1} / ${total}` : "";
    }
  }

  // ---- Message Listener (Simplified Call) ----
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "toggleSearchUI") {
      // console.log("Message received: toggleSearchUI");
      // Always ensure UI exists/refs are valid, then toggle visibility
      ensureUI(); // Creates if needed, gets refs
      if (!isVisible) {
        showSearchUI(); // showSearchUI also calls ensureUI, but call here ensures refs before decision
        sendResponse({ status: "UI Shown" });
      } else {
        hideSearchUI();
        sendResponse({ status: "UI Hidden" });
      }
      return true; // Indicate potential async response
    }
    return false;
  });

  // console.log("Regex Rabbit content script listener ready.");
})(); // End IIFE
