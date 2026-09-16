import UIKit
import Capacitor

// Capacitor's web view, plus JConnect's own native code: finding computers on the network and connecting to them.
class JConnectViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(DevicePlugin())
        bridge?.registerPluginInstance(SocketPlugin())
    }
}
