import SwiftCrossUI

/// Deterministic font-registration smoke surface. It is available only through
/// the explicit `-T4TypographyFixture` launch seam and is never ordinary UI.
struct T4TypographyFixtureView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Omperator typography")
                .font(.system(size: 19, weight: .bold))
            Text("Fira Sans / Cantarell interface sample")
                .font(.bodyF(15))
            Text("Assistant prose sample with emphasis")
                .font(.serif(18))
            Text("let connection = relay.rejoin()")
                .font(.term(12.5))
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(hex: 0x232136))
        .foregroundColor(Color(hex: 0xE0DEF4))
    }
}
