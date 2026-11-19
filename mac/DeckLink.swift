// A Steam Deck reboot can return an open Steam Link session to its pairing screen.
// Select only the paired host's named Start Playing button, through macOS Accessibility.
import AppKit
import ApplicationServices

let steamID = "com.valvesoftware.SteamLink17"
let endpoint = URL(string: "http://127.0.0.1:4040/api/boot")!
let configuredName = CommandLine.arguments.dropFirst().first { !$0.hasPrefix("--") } ?? "steamdeck"
let playLabels = ["Start Playing", "Começar a jogar", "Iniciar transmissão", "Jogar agora"]
func report(_ message: String) {
    FileHandle.standardError.write(Data(("Deck Link: " + message + "\n").utf8))
}
func attribute(_ item: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(item, name as CFString, &result) == .success else { return nil }
    return result
}
func currentBoot() -> UUID? {
    // The endpoint is local, read-only, bounded, and independent of the size of the test queue.
    let done = DispatchSemaphore(value: 0)
    var result: UUID?
    let request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
    URLSession.shared.dataTask(with: request) { data, response, _ in
        if (response as? HTTPURLResponse)?.statusCode == 200, let data = data,
           let value = String(data: data, encoding: .utf8) { result = UUID(uuidString: value) }
        done.signal()
    }.resume()
    done.wait()
    return result
}
func mainWindow(_ pid: pid_t) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1)
    // Steam Link returns an empty AXWindows array on its home screen.
    if let value = attribute(app, kAXMainWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() {
        return (value as! AXUIElement)
    }
    return (attribute(app, kAXWindowsAttribute) as? [AXUIElement])?.first
}
func resume(_ window: AXUIElement) -> Bool {
    guard (attribute(window, kAXMinimizedAttribute) as? Bool) == false else { return false }
    let children = attribute(window, kAXChildrenAttribute) as? [AXUIElement] ?? []
    let labels = children.compactMap { attribute($0, kAXValueAttribute) as? String }
    guard labels.contains(where: { $0.caseInsensitiveCompare(configuredName) == .orderedSame }),
          !labels.contains(where: { ["Offline", "Desconectado"].contains($0) }) else { return false }
    guard let play = children.first(where: {
        attribute($0,kAXRoleAttribute) as? String == kAXButtonRole &&
        playLabels.contains(attribute($0,kAXTitleAttribute) as? String ?? "") &&
        ((attribute($0,kAXEnabledAttribute) as? Bool) != false)
    }) else { return false }
    return AXUIElementPerformAction(play, kAXPressAction as CFString) == .success
}

struct Frame {
    let origin: AXValue
    let size: AXValue
    init?(_ window: AXUIElement) {
        guard let point = attribute(window, kAXPositionAttribute), CFGetTypeID(point) == AXValueGetTypeID(),
              let rect = attribute(window, kAXSizeAttribute), CFGetTypeID(rect) == AXValueGetTypeID()
        else { return nil }
        origin = (point as! AXValue)
        size = (rect as! AXValue)
    }
    func restore(_ window: AXUIElement) {
        AXUIElementSetAttributeValue(window,kAXSizeAttribute as CFString,size)
        AXUIElementSetAttributeValue(window,kAXPositionAttribute as CFString,origin)
    }
}

if CommandLine.arguments.contains("--authorize") {
    let opt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    report(AXIsProcessTrustedWithOptions(opt) ? "accessibility enabled" : "waiting for accessibility permission")
    exit(0)
}
let link = { NSRunningApplication.runningApplications(withBundleIdentifier: steamID).first }
if CommandLine.arguments.contains("--status") {
    let title = link().flatMap { mainWindow($0.processIdentifier) }.flatMap { attribute($0,kAXTitleAttribute) as? String }
    print("accessibility=\(AXIsProcessTrusted()) boot=\(currentBoot() != nil) window=\(title ?? "none")")
    exit(0)
}
if CommandLine.arguments.contains("--resume-now") {
    guard AXIsProcessTrusted(), let pid = link()?.processIdentifier, let win = mainWindow(pid), resume(win)
    else { report("paired host's Start Playing button unavailable"); exit(1) }
    report("selected Start Playing for the paired host")
    exit(0)
}

var lastPID: pid_t?, lastBoot: UUID?, deadline: Date?, frame: Frame?
var nextTry = Date.distantPast
var pressed = false
while true {
    autoreleasepool {
        guard AXIsProcessTrusted(), let pid = link()?.processIdentifier else {
            lastPID = nil; lastBoot = nil; deadline = nil; frame = nil
            return
        }
        if lastPID != pid {
            lastPID = pid; lastBoot = nil; deadline = nil; frame = nil
        }
        guard let boot = currentBoot() else { return }
        if let previous = lastBoot, previous != boot {
            deadline = Date().addingTimeInterval(150)
            nextTry = Date()
            pressed = false
            report("observed a new Deck boot")
        }
        lastBoot = boot
        guard let win = mainWindow(pid) else { return }
        let streaming = (attribute(win,kAXTitleAttribute) as? String ?? "").hasSuffix("[Streaming]")
        if let until = deadline {
            if Date() > until { deadline = nil; report("window did not resume before timeout"); return }
            if streaming && pressed {
                frame?.restore(win)
                deadline = nil
                report("desktop stream resumed in the running Steam Link application")
            } else if !streaming && Date() >= nextTry && resume(win) {
                pressed = true
                nextTry = Date().addingTimeInterval(25)
                report("selected Start Playing for the paired host")
            }
        } else if streaming, (attribute(win,kAXMinimizedAttribute) as? Bool) == false {
            frame = Frame(win)
        }
    }
    Thread.sleep(forTimeInterval: 4)
}
