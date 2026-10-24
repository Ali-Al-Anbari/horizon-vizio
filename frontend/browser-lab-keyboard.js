(function (root) {
  "use strict";
  var core = root.HorizonBrowserCore;

  function fireInput(input, name) {
    var event;
    if (typeof Event === "function") event = new Event(name, { bubbles: true });
    else {
      event = document.createEvent("Event");
      event.initEvent(name, true, false);
    }
    input.dispatchEvent(event);
  }

  function TVKeyboard(panel, preview, grid, onClose) {
    this.panel = panel;
    this.preview = preview;
    this.grid = grid;
    this.onClose = onClose;
    this.position = { row: 0, col: 0 };
    this.shifted = false;
    this.input = null;
    this.buttons = [];
    for (var row = 0; row < core.rows.length; row++) {
      var line = document.createElement("div");
      line.className = "keyboard-row";
      var buttons = [];
      for (var col = 0; col < core.rows[row].length; col++) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "keyboard-key";
        button.textContent = core.rows[row][col] === "Space" ? "Space" : core.rows[row][col];
        button.setAttribute("aria-label", button.textContent);
        (function (self, r, c) {
          button.addEventListener("click", function () {
            self.position = { row: r, col: c };
            self.select();
            self.press();
          });
        })(this, row, col);
        line.appendChild(button);
        buttons.push(button);
      }
      grid.appendChild(line);
      this.buttons.push(buttons);
    }
  }

  TVKeyboard.prototype.open = function (input) {
    this.input = input;
    this.shifted = false;
    this.position = { row: 0, col: 0 };
    this.panel.hidden = false;
    this.preview.textContent = input.value || " ";
    this.renderShift();
    this.select();
  };

  TVKeyboard.prototype.renderShift = function () {
    var shift = this.buttons[4][0];
    if (this.shifted) shift.classList.add("is-shifted");
    else shift.classList.remove("is-shifted");
    for (var row = 0; row < 3; row++) {
      for (var col = 0; col < this.buttons[row].length; col++) {
        var key = core.rows[row][col];
        if (/^[a-z]$/.test(key)) this.buttons[row][col].textContent = this.shifted ? key.toUpperCase() : key;
      }
    }
  };

  TVKeyboard.prototype.select = function () {
    var old = this.grid.querySelector(".is-selected");
    if (old) old.classList.remove("is-selected");
    var button = this.buttons[this.position.row][this.position.col];
    button.classList.add("is-selected");
    try { button.focus({ preventScroll: true }); } catch (_error) { button.focus(); }
  };

  TVKeyboard.prototype.move = function (key) {
    this.position = core.moveKey(this.position, key);
    this.select();
  };

  TVKeyboard.prototype.press = function () {
    if (!this.input) return;
    var key = core.rows[this.position.row][this.position.col];
    var next = core.editValue(this.input.value, key, this.shifted);
    this.shifted = next.shifted;
    if (key === "Shift") this.renderShift();
    if (next.value !== this.input.value) {
      this.input.value = next.value;
      fireInput(this.input, "input");
    }
    this.preview.textContent = this.input.value || " ";
    if (next.done) {
      fireInput(this.input, "change");
      this.close(true);
    }
  };

  TVKeyboard.prototype.close = function (submitted) {
    if (!this.input) return;
    var input = this.input;
    this.input = null;
    this.panel.hidden = true;
    this.onClose(input, submitted === true);
  };

  root.HorizonTVKeyboard = TVKeyboard;
})(window);
