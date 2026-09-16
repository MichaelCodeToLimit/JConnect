import AVFoundation
import Capacitor
import Darwin
import Foundation

// What the web client can't do by itself on iPhone and iPad: hear which JConnect computers are announcing themselves on
// the local network. The app is updated through TestFlight and the App Store, so unlike Android there's no updater here.
@objc(DevicePlugin)
public class DevicePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DevicePlugin"
    public let jsName = "JConnectDevice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listen", returnType: CAPPluginReturnPromise),
    ]

    private static let discoveryPort: UInt16 = 47802
    private static let maxMessages = 64

    @objc func info(_ call: CAPPluginCall) {
        var result: [String: Any] = [
            "platform": "ios",
            "television": false,
            "camera": AVCaptureDevice.default(for: .video) != nil,
        ]
        // CI starts the app with "-JConnectSelfTest <host:port?code=…>" to pair with a test computer (see native.js).
        if let selfTest = UserDefaults.standard.string(forKey: "JConnectSelfTest"), !selfTest.isEmpty {
            result["selfTest"] = selfTest
        }
        call.resolve(result)
    }

    // Listens for JConnect announcements for a few seconds. Each comes back with the address it came from; the web
    // client checks them, because anything on the network can send one. On an iPhone or iPad, receiving broadcasts
    // needs Apple's multicast networking entitlement; without it nothing arrives and the list simply stays empty.
    @objc func listen(_ call: CAPPluginCall) {
        let ms = max(500, min(call.getInt("ms") ?? 4500, 10000))
        DispatchQueue.global(qos: .userInitiated).async {
            let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
            guard fd >= 0 else {
                call.reject("Couldn't listen on the network: \(DevicePlugin.lastError())")
                return
            }
            defer { close(fd) }

            var yes: Int32 = 1
            let optionSize = socklen_t(MemoryLayout<Int32>.size)
            setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, optionSize)
            setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &yes, optionSize)
            setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &yes, optionSize)

            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = DevicePlugin.discoveryPort.bigEndian
            address.sin_addr = in_addr(s_addr: INADDR_ANY)
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            guard bound == 0 else {
                call.reject("Couldn't listen on the network: \(DevicePlugin.lastError())")
                return
            }

            var messages: [[String: Any]] = []
            var buffer = [UInt8](repeating: 0, count: 4096)
            let end = Date().addingTimeInterval(Double(ms) / 1000)
            while messages.count < DevicePlugin.maxMessages {
                let left = end.timeIntervalSinceNow
                if left <= 0 { break }
                var timeout = timeval(tv_sec: Int(left), tv_usec: Int32((left - left.rounded(.down)) * 1_000_000))
                setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

                var from = sockaddr_in()
                var fromLength = socklen_t(MemoryLayout<sockaddr_in>.size)
                let received = buffer.withUnsafeMutableBytes { raw in
                    withUnsafeMutablePointer(to: &from) {
                        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                            recvfrom(fd, raw.baseAddress, raw.count, 0, $0, &fromLength)
                        }
                    }
                }
                if received < 0 {
                    if errno == EINTR { continue }
                    if errno == EAGAIN || errno == EWOULDBLOCK { break }
                    call.reject("Couldn't listen on the network: \(DevicePlugin.lastError())")
                    return
                }

                var sender = from.sin_addr
                var host = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                inet_ntop(AF_INET, &sender, &host, socklen_t(INET_ADDRSTRLEN))
                messages.append([
                    "address": host.withUnsafeBufferPointer { String(cString: $0.baseAddress!) },
                    "text": String(decoding: buffer[0..<received], as: UTF8.self),
                ])
            }
            call.resolve(["messages": messages])
        }
    }

    private static func lastError() -> String {
        String(cString: strerror(errno))
    }
}
