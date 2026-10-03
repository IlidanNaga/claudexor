import AppKit
import SwiftUI
import Testing
@testable import ClaudexorApp

/// Opt-in native consumer qualification. This hosts only the real preview
/// sheet in an unshown window; it never constructs AppModel or launches the app.
/// Run with C347_RENDER_QA=1 on a macOS host with a window server. Optional
/// C347_RENDER_OUTPUT writes only this view's PNGs, never a desktop screenshot.
/// SwiftUI's unshown host does not expose working checkbox/link actions here.
/// This qualifies rendering only; actual toggle/link interaction needs app QA.
@MainActor
@Suite(.serialized)
struct SafeFilePreviewRenderingTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["C347_RENDER_QA"] == "1"))
    func nativeMarkdownAndPassiveSourceRender() async throws {
        let application = NSApplication.shared
        let priorPolicy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(priorPolicy) }

        let markdown = """
        # Consumer heading

        Formatted **body** with `inline code`.

        [Jump inside preview](#anchor)

        - First item
        - Second item

        | Item | Value |
        | --- | --- |
        | Mode | Passive |

        ```swift
        let passive = true
        ```

        ![unloaded image](https://example.invalid/never-fetch.png)
        """
        let (window, host) = makeHost(text: markdown, name: "consumer.md", kind: .markdown)
        defer { window.close() }
        try await settle(host)

        let formatted = accessibilityText(host)
        #expect(formatted.contains("Consumer heading"))
        #expect(formatted.contains("Formatted body with inline code."))
        #expect(formatted.contains("First item"))
        #expect(formatted.contains("Passive"))
        #expect(formatted.contains("let passive = true"))
        #expect(formatted.contains("![unloaded image](https://example.invalid/never-fetch.png)"))
        #expect(!formatted.contains("# Consumer heading"))
        try capture(host, named: "markdown-formatted")
        host.appearance = NSAppearance(named: .darkAqua)
        try await settle(host)
        try capture(host, named: "markdown-formatted-dark")
        host.appearance = NSAppearance(named: .aqua)

        // Exercise the shared literal-source renderer directly. This is NOT a
        // substitute for a successful click of the Markdown sheet's toggle.
        let (literalWindow, literalHost) = makeHost(
            text: markdown, name: "markdown-source.txt", kind: .source)
        defer { literalWindow.close() }
        try await settle(literalHost)
        let source = accessibilityText(literalHost)
        #expect(source.contains("# Consumer heading"))
        #expect(source.contains("Formatted **body** with `inline code`."))
        #expect(source.contains("| --- | --- |"))
        try capture(literalHost, named: "markdown-literal-source")

        // The sheet's own footer (Reveal in Finder, Done) is the only place a
        // button may come from; SwiftUI backs each with a native NSButton here.
        // Measure that on a content-free sheet instead of hardcoding a count.
        let (chromeWindow, chromeHost) = makeHost(
            text: nil, name: "chrome.html", kind: .blocked(reason: "footer calibration"))
        defer { chromeWindow.close() }
        try await settle(chromeHost)
        let footerButtons = buttons(chromeHost).count

        let html = "<html><script>window.neverExecute = true</script><svg onload='never()'/></html>"
        let (sourceWindow, sourceHost) = makeHost(text: html, name: "passive.html", kind: .source)
        defer { sourceWindow.close() }
        try await settle(sourceHost)
        #expect(accessibilityText(sourceHost).contains(html))
        #expect(buttons(try #require(literalPane(sourceHost))).isEmpty)
        #expect(buttons(sourceHost).count == footerButtons)
        try capture(sourceHost, named: "html-literal-source")

        let svg = "<svg xmlns='http://www.w3.org/2000/svg' onload='never()'><script>never()</script></svg>"
        let (svgWindow, svgHost) = makeHost(text: svg, name: "passive.svg", kind: .source)
        defer { svgWindow.close() }
        try await settle(svgHost)
        #expect(accessibilityText(svgHost).contains(svg))
        #expect(buttons(try #require(literalPane(svgHost))).isEmpty)
        #expect(buttons(svgHost).count == footerButtons)
        try capture(svgHost, named: "svg-literal-source")

        let (errorWindow, errorHost) = makeHost(text: nil, name: "unreadable.md", kind: .markdown)
        defer { errorWindow.close() }
        try await settle(errorHost)
        // Unshown SwiftUI windows expose selected native text but omit these
        // nonselectable labels from AX. Their PNGs require visual inspection;
        // pixel capture alone is not an automated assertion of the label text.
        try capture(errorHost, named: "markdown-unavailable")

        let (boundedWindow, boundedHost) = makeHost(
            text: "# Bounded source", name: "truncated.md", kind: .markdown, wasTruncated: true)
        defer { boundedWindow.close() }
        try await settle(boundedHost)
        #expect(accessibilityText(boundedHost).contains("Bounded source"))
        try capture(boundedHost, named: "markdown-truncated")

        // The existing per-cell bound keeps this render-cap fixture small on
        // screen: only 500 cell characters reach layout, never 200,000 glyphs.
        let capped = "| Bounded cell |\n| --- |\n| " +
            String(repeating: "a", count: MarkdownOutputView.renderCharCap + 1) + " |"
        let (capWindow, capHost) = makeHost(text: capped, name: "render-cap.md", kind: .markdown)
        defer { capWindow.close() }
        try await settle(capHost)
        #expect(accessibilityText(capHost).contains("Bounded cell"))
        #expect(!accessibilityText(capHost).contains(String(repeating: "a", count: 501)))
        try capture(capHost, named: "markdown-render-cap")
    }

    private func makeHost(
        text: String?, name: String, kind: AgentFilePreviewKind, wasTruncated: Bool = false
    ) -> (NSWindow, NSHostingView<AnyView>) {
        let request = SafeFilePreviewRequest(
            url: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(name),
            kind: kind,
            source: text.map { .init(bytes: Data($0.utf8), wasTruncated: wasTruncated) })
        let host = NSHostingView(rootView: AnyView(
            SafeFilePreviewSheet(request: request)
                .background(Color(nsColor: .windowBackgroundColor))))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 760),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.frame = NSRect(x: 0, y: 0, width: 900, height: 760)
        host.appearance = NSAppearance(named: .aqua)
        return (window, host)
    }

    private func settle(_ host: NSView) async throws {
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
    }

    private func accessibilityNodes(_ root: NSView) -> [any NSAccessibilityProtocol] {
        var pending: [Any] = [root]
        if let window = root.window { pending.append(window) }
        var seen: Set<ObjectIdentifier> = []
        var result: [any NSAccessibilityProtocol] = []
        while let next = pending.popLast() {
            let object = next as AnyObject
            guard seen.insert(ObjectIdentifier(object)).inserted else { continue }
            if let view = next as? NSView { pending.append(contentsOf: view.subviews) }
            guard let node = next as? any NSAccessibilityProtocol else { continue }
            result.append(node)
            pending.append(contentsOf: node.accessibilityChildren() ?? [])
            pending.append(contentsOf: NSAccessibility.unignoredChildren(from: node.accessibilityChildren() ?? []))
        }
        return result
    }

    private func nativeViews(_ root: NSView) -> [NSView] {
        [root] + root.subviews.flatMap(nativeViews)
    }

    private func buttons(_ root: NSView) -> [NSButton] {
        nativeViews(root).compactMap { $0 as? NSButton }
    }

    /// The literal-source pane: the scroll view whose document is the passive text view.
    private func literalPane(_ root: NSView) -> NSView? {
        nativeViews(root).first { ($0 as? NSScrollView)?.documentView is NSTextView }
    }

    private func accessibilityText(_ root: NSView) -> String {
        accessibilityNodes(root).flatMap { node in
            [node.accessibilityLabel(), node.accessibilityTitle(), node.accessibilityValue() as? String].compactMap { $0 }
        }.joined(separator: "\n")
    }

    private func capture(_ host: NSView, named name: String) throws {
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        #expect(bitmap.pixelsWide >= 900)
        #expect(bitmap.pixelsHigh >= 760)
        let data = try #require(bitmap.representation(using: .png, properties: [:]))
        if let output = ProcessInfo.processInfo.environment["C347_RENDER_OUTPUT"] {
            let directory = URL(fileURLWithPath: output, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: directory.appendingPathComponent(name + ".png"))
        }
    }
}
