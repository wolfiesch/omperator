//  T4ModelLabel.swift
//  Provider-first model labeling. Every place a model appears shows the
//  PROVIDER as a distinct chip plus the model name — never a bare model
//  string, so "deepseek-v4-flash" can never be mistaken for an OpenAI model.
//  Handles "provider/model" selectors and bare model names.

import SwiftUI

/// Splits a model selector into (provider, model). "deepseek/deepseek-v4-flash"
/// → ("deepseek", "deepseek-v4-flash"); "gpt-5.2" → (nil, "gpt-5.2").
func splitModelSelector(_ selector: String) -> (provider: String?, model: String) {
    guard let slash = selector.firstIndex(of: "/") else { return (nil, selector) }
    let provider = String(selector[..<slash])
    let model = String(selector[selector.index(after: slash)...])
    return provider.isEmpty || model.isEmpty ? (nil, selector) : (provider, model)
}

/// Provider in the terminal voice + model name. No chip, no capsule — the
/// VT323 pixel face in the accent IS the label.
struct T4ModelLabel: View {
    let selector: String
    let theme: Theme
    var size: CGFloat = 11

    var body: some View {
        let (provider, model) = splitModelSelector(selector)
        HStack(spacing: 6) {
            Image(systemName: "cpu")
                .font(.system(size: size))
                .foregroundStyle(theme.txtLabel)
            if let provider {
                Text(provider)
                    .font(.term(size + 4))
                    .foregroundStyle(theme.accent)
            }
            Text(model)
                .font(.system(size: size))
                .foregroundStyle(theme.txtMuted)
                .lineLimit(1)
        }
    }
}
