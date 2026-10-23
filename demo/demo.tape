# Recording of OpenCode driving humans& Ampersand through opencode-humansand.
# Run from the repo root with HUMANSAND_API_KEY exported:  vhs demo/demo.tape
Output demo/demo.gif
Output demo/demo.mp4
Set Shell zsh
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set Framerate 30

Hide
Type "cd demo/project && git restore src && clear" Enter
Sleep 500ms
Show

Type "opencode --standalone --auto"
Sleep 800ms
Enter
Sleep 7s

Type "the test suite is failing. find out why, fix it, and run the tests again"
Sleep 1200ms
Enter
Wait+Screen@180s /tok\/s/
Sleep 6s
Screenshot demo/demo.png
Sleep 3s
