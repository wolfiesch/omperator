import SwiftUI
import UIKit

extension Color {
    static let enclaveAccent = Color(uiColor: UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0xC8/255, green: 0xD6/255, blue: 0xE5/255, alpha: 1)
            : UIColor(red: 0xEA/255, green: 0x9D/255, blue: 0x34/255, alpha: 1)
    })
    static let enclaveLove = Color(uiColor: UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0xE8/255, green: 0x91/255, blue: 0x9F/255, alpha: 1)
            : UIColor(red: 0xB4/255, green: 0x63/255, blue: 0x7A/255, alpha: 1)
    })
}
