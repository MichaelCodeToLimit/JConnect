import Capacitor
import Foundation

// WebSockets for the web client. The iOS web view's own WebSocket always sends "Origin: capacitor://localhost", and a
// JConnect computer only accepts origins it knows, so computers already installed would turn the app away. Native
// sockets send no Origin, like any other app, so native.js runs the page's WebSocket through here.
@objc(SocketPlugin)
public class SocketPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionWebSocketDelegate {
    public let identifier = "SocketPlugin"
    public let jsName = "JConnectSocket"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
    ]

    private static let maxMessageSize = 4 * 1024 * 1024

    // Everything below runs on this one queue, so events reach the page in the order they happened.
    private let queue = DispatchQueue(label: "app.jconnect.sockets")
    private lazy var session: URLSession = {
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        delegateQueue.underlyingQueue = queue
        return URLSession(configuration: .ephemeral, delegate: self, delegateQueue: delegateQueue)
    }()
    private var sockets: [Int: URLSessionWebSocketTask] = [:]

    @objc func open(_ call: CAPPluginCall) {
        guard let id = call.getInt("id"),
              let text = call.getString("url"),
              let url = URL(string: text),
              let scheme = url.scheme?.lowercased(), scheme == "ws" || scheme == "wss" else {
            call.reject("That isn't a WebSocket address")
            return
        }
        queue.async {
            let task = self.session.webSocketTask(with: url)
            task.maximumMessageSize = SocketPlugin.maxMessageSize
            task.taskDescription = String(id)
            self.sockets[id] = task
            task.resume()
            call.resolve()
        }
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let id = call.getInt("id") else {
            call.reject("No socket")
            return
        }
        let message: URLSessionWebSocketTask.Message
        if let text = call.getString("text") {
            message = .string(text)
        } else if let base64 = call.getString("data"), let data = Data(base64Encoded: base64) {
            message = .data(data)
        } else {
            call.reject("Nothing to send")
            return
        }
        queue.async {
            guard let task = self.sockets[id] else {
                call.reject("The socket is closed")
                return
            }
            task.send(message) { error in
                if let error = error { call.reject(error.localizedDescription) } else { call.resolve() }
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        guard let id = call.getInt("id") else {
            call.reject("No socket")
            return
        }
        let code = call.getInt("code") ?? 1000
        let reason = call.getString("reason") ?? ""
        queue.async {
            if let task = self.sockets[id] {
                let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
                task.cancel(with: closeCode, reason: reason.data(using: .utf8))
            }
            call.resolve()
        }
    }

    // ---------- events ----------

    private func emit(_ id: Int, _ event: [String: Any]) {
        var data = event
        data["id"] = id
        notifyListeners("socket", data: data)
    }

    private func socketId(_ task: URLSessionTask) -> Int? {
        guard let text = task.taskDescription, let id = Int(text), sockets[id] === task else { return nil }
        return id
    }

    private func receive(_ id: Int, _ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self = self, self.sockets[id] === task else { return }
            switch result {
            case .success(.string(let text)):
                self.emit(id, ["type": "text", "data": text])
                self.receive(id, task)
            case .success(.data(let data)):
                self.emit(id, ["type": "binary", "data": data.base64EncodedString()])
                self.receive(id, task)
            case .success:
                self.receive(id, task)
            case .failure:
                // The close itself is reported by the delegate below.
                break
            }
        }
    }

    private func finish(_ id: Int, code: Int, reason: String, clean: Bool) {
        sockets[id] = nil
        emit(id, ["type": "close", "code": code, "reason": reason, "clean": clean])
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard let id = socketId(webSocketTask) else { return }
        emit(id, ["type": "open"])
        receive(id, webSocketTask)
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard let id = socketId(webSocketTask) else { return }
        // URLSession can't represent a computer's own close codes (4000 and up) and reports them as "invalid".
        let code = closeCode == .invalid ? 1006 : closeCode.rawValue
        let text = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        finish(id, code: code, reason: text, clean: closeCode != .invalid)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = socketId(task) else { return }
        let reason = (task as? URLSessionWebSocketTask).flatMap { $0.closeReason }.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        finish(id, code: 1006, reason: reason, clean: false)
    }
}
