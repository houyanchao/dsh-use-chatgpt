import Foundation
import Security

let arguments = CommandLine.arguments
guard arguments.count == 3,
      ["read", "get-or-create"].contains(arguments[1]),
      arguments[2].utf8.count == 64,
      arguments[2].utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
  exit(64)
}

let item: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: "dsh-use-chatgpt.credential-encryption.v1",
  kSecAttrAccount as String: arguments[2],
]

func readKey() -> (OSStatus, Data?) {
  var query = item
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  return (status, result as? Data)
}

func createKey() -> (OSStatus, Data?) {
  var key = Data(count: 32)
  let randomStatus = key.withUnsafeMutableBytes { buffer in
    SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
  }
  if randomStatus != errSecSuccess { return (randomStatus, nil) }
  var attributes = item
  attributes[kSecValueData as String] = key
  let status = SecItemAdd(attributes as CFDictionary, nil)
  // Another process could create the same key after our initial lookup.
  if status == errSecDuplicateItem { return readKey() }
  return (status, status == errSecSuccess ? key : nil)
}

var (status, key) = readKey()
if status == errSecItemNotFound && arguments[1] == "get-or-create" {
  (status, key) = createKey()
}
if status == errSecItemNotFound { exit(2) }
guard status == errSecSuccess, let key, key.count == 32 else {
  try? FileHandle.standardError.write(contentsOf: Data("Keychain status: \(status)\n".utf8))
  exit(1)
}

try FileHandle.standardOutput.write(contentsOf: key)
