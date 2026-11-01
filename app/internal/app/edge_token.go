package app

// The Sec-MS-GEC v2 token.
//
// WHY THIS EXISTS: the read-aloud endpoint rejects any request whose token was
// not produced by the CURRENT algorithm — the plain SHA-256 of the old version
// is answered with 403, and there is no error message to read. The token is
// deliberately obscured upstream (a salted "SHA-256" whose state, schedule and
// round constants are pre-mixed, plus a separate CS64 fold of the same input),
// because it is a client fingerprint: Microsoft wants the token to come from
// Edge, not from a script.
//
// So this file is a faithful port of edge_tts/drm.py (7.3.1, MIT). Two rules
// apply to it, and to nothing else in this package:
//
//   - Do not "clean it up". Every constant below is load-bearing; the values
//     look arbitrary because they are. A refactor that works on paper will
//     produce a token the server silently rejects.
//   - It is expected to break. When Microsoft rotates the algorithm again the
//     fix is to re-port the upstream file, not to debug this one.
//
// It is also the only reason the online voice is optional: everything else in
// 听书 works without it (see TtsBridge.java for the system engine).

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math/bits"
	"strings"
)

const (
	edgeU32Mask          uint32 = 0xffffffff
	edgeCS64Factor       uint32 = 0x82893933
	edgeCS64Adjustment0  uint32 = 0xf2f90b1a
	edgeCS64Adjustment1  uint32 = 0x0b1a0000
	edgeSHA256Adjustment uint32 = 0xc9dc06a7
	edgeSigma0Adjustment uint32 = 0x059c0b80
	edgeSigma1Adjustment uint32 = 0x000b92c0
)

var edgeSHA256Initial = [8]uint32{
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
	0x1f83d9ab, 0x5be0cd19,
}

var edgeSHA256State = [8]uint32{
	0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab,
	0xfeb0a7e4, 0x03effbd2,
}

var edgeSHA256Schedule = [14]uint32{
	0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491,
	0xc0dd25a0, 0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
	0xd258b060, 0x72766564,
}

var edgeSHA256RoundConstants = [64]uint32{
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}

var edgeCS64Coefficients = [...][2]uint32{
	{0xe82e91b1, 0xb32700d0},
	{0x44de24c6, 0x88dff51d},
	{0x3beb65bc, 0x29514038},
	{0xc89c5933, 0xb328cbdf},
	{0x8d1ec211, 0xd405b4d5},
	{0x314ef5d5, 0x26e55f3c},
	{0xe92491b1, 0x607801c6},
	{0xf0a5b9d5, 0x82b2c1fb},
	{0x06064cf3, 0xfa51a3da},
	{0xda79fa60, 0x207cc464},
	{0xbed20560, 0x3c3c74f3},
	{0x89f9c9f8, 0xd2d14b61},
	{0x35fa38c6, 0xbb04a2c1},
	{0xcb49e3c6, 0xc5626167},
}

// edgeRot16 rotates a 32-bit word left by 16 — a plain byte swap.
func edgeRot16(v uint32) uint32 { return v<<16 | v>>16 }

func edgeSigma0(v uint32) uint32 { return (v>>7 ^ v<<25 ^ v>>18 ^ v<<14 ^ v>>3) & edgeU32Mask }

func edgeSigma1(v uint32) uint32 { return (v>>17 ^ v<<15 ^ v>>19 ^ v<<13 ^ v>>10) & edgeU32Mask }

// edgeSHA256Rounds is the compression function. The upstream Python unrolls it
// eight rounds at a time with rotated register roles; this is the same function
// written the ordinary way, with `firstRound` skipping the no-op opening rounds
// of the salted initial state.
func edgeSHA256Rounds(state [8]uint32, words []uint32, firstRound int) [8]uint32 {
	a, b, c, d, e, f, g, h := state[0], state[1], state[2], state[3], state[4], state[5], state[6], state[7]
	consts := &edgeSHA256RoundConstants
	if firstRound == 14 {
		// Round 14 uses the adjusted constant; the rest of the table is shared.
		block := edgeSHA256RoundConstants
		block[14] = edgeSHA256Adjustment
		consts = &block
	}
	for i := firstRound; i < 64; i++ {
		t1 := h +
			(bits.RotateLeft32(e, -6) ^ bits.RotateLeft32(e, -11) ^ bits.RotateLeft32(e, -25)) +
			(g ^ (e & (f ^ g))) +
			consts[i] + words[i]
		t2 := (bits.RotateLeft32(a, -2) ^ bits.RotateLeft32(a, -13) ^ bits.RotateLeft32(a, -22)) +
			((a & b) | (c & (a | b)))
		h, g, f = g, f, e
		e = d + t1
		d, c, b = c, b, a
		a = t1 + t2
	}
	return [8]uint32{a, b, c, d, e, f, g, h}
}

func edgeExpandSchedule(words []uint32, firstWord int) {
	for i := firstWord; i < 64; i++ {
		words[i] = edgeSigma1(words[i-2]) + words[i-7] + edgeSigma0(words[i-15]) + words[i-16]
	}
}

// edgeSHA256Init builds the working state from the first seven bytes of the
// token input; the schedule it starts from is pre-mixed, so rounds 0..13 are
// skipped rather than run.
func edgeSHA256Init(data []byte) [8]uint32 {
	words := make([]uint32, 64)
	words[14] = uint32(data[0])<<16 | uint32(data[1])<<8 | uint32(data[2])
	words[15] = binary.BigEndian.Uint32(data[3:7])
	for i := 16; i <= 29; i++ {
		v := edgeSHA256Schedule[i-16]
		if i-2 >= 14 {
			s := edgeSigma1(words[i-2])
			if i == 16 {
				s ^= edgeSigma1Adjustment
			}
			v += s
		}
		if i-7 >= 14 {
			v += words[i-7]
		}
		if i-15 >= 14 {
			s := edgeSigma0(words[i-15])
			if i == 29 {
				s ^= edgeSigma0Adjustment
			}
			v += s
		}
		words[i] = v & edgeU32Mask
	}
	words[30] = edgeSigma1(words[28]) + words[23] + edgeSigma0(words[15]) + words[14] +
		edgeSHA256Adjustment - edgeSHA256RoundConstants[14]
	edgeExpandSchedule(words, 31)
	working := edgeSHA256Rounds(edgeSHA256State, words, 14)
	var out [8]uint32
	for i := range out {
		out[i] = edgeSHA256Initial[i] + working[i]
	}
	return out
}

// edgeSHA256Digest is the salted digest: the first seven bytes seed the state,
// the rest is Merkle–Damgård padded and absorbed block by block.
func edgeSHA256Digest(data []byte) ([32]byte, bool) {
	var out [32]byte
	if len(data) < 7 {
		return out, false
	}
	length := 57 + len(data)
	padded := make([]byte, 0, len(data)+72)
	padded = append(padded, data[7:]...)
	padded = append(padded, 0x80)
	// Go's % keeps the sign of the dividend; Python's does not.
	zeros := (55 - length) % 64
	if zeros < 0 {
		zeros += 64
	}
	padded = append(padded, make([]byte, zeros)...)
	var lb [8]byte
	binary.BigEndian.PutUint64(lb[:], uint64(length)*8)
	padded = append(padded, lb[:]...)

	state := edgeSHA256Init(data[:7])
	words := make([]uint32, 64)
	for off := 0; off < len(padded); off += 64 {
		for i := 0; i < 16; i++ {
			words[i] = binary.BigEndian.Uint32(padded[off+4*i:])
		}
		edgeExpandSchedule(words, 16)
		working := edgeSHA256Rounds(state, words, 0)
		for i := range state {
			state[i] += working[i]
		}
	}
	for i, w := range state {
		binary.BigEndian.PutUint32(out[4*i:], w)
	}
	return out, true
}

// edgeWordsLE4Even splits data into little-endian 32-bit words, zero-padded to
// an even count (the CS64 loop consumes them two at a time).
func edgeWordsLE4Even(data []byte) []uint32 {
	padded := make([]byte, len(data))
	copy(padded, data)
	for len(padded)%4 != 0 {
		padded = append(padded, 0)
	}
	words := make([]uint32, len(padded)/4)
	for i := range words {
		words[i] = binary.LittleEndian.Uint32(padded[4*i:])
	}
	if len(words)%2 != 0 {
		words = append(words, 0)
	}
	return words
}

// edgeCS64Digest folds the token input into two words with the same key material
// the salted digest used. Nonsense as cryptography; it is a fingerprint.
func edgeCS64Digest(data []byte, digest [32]byte) (uint32, uint32) {
	keyA := binary.LittleEndian.Uint32(digest[0:4]) | 1
	keyB := binary.LittleEndian.Uint32(digest[4:8]) | 1
	factors := [2]uint32{keyA * edgeCS64Factor, keyB * edgeCS64Factor}

	terms := make([]uint32, 0, 64)
	offsets := make([]uint32, 0, 64)
	for i, c := range edgeCS64Coefficients {
		terms = append(terms, c[0]*factors[i%2])
		offsets = append(offsets, c[1])
	}
	for i, w := range edgeWordsLE4Even(append([]byte{0}, data...)) {
		term := w * keyA
		offset := edgeRot16(w) * 0xEF0569FB
		if i%2 == 1 {
			term = w * keyB
			offset = edgeRot16(w) * 0xC31713DB
		}
		if i == 0 {
			term += edgeCS64Adjustment0 * factors[0]
			offset += edgeCS64Adjustment1
		}
		terms = append(terms, term)
		offsets = append(offsets, offset)
	}

	var swapAcc, swapLast, state, acc uint32
	for i := 0; i < len(terms); i += 2 {
		x, y := terms[i], terms[i+1]

		t := edgeRot16(offsets[i] + x)
		q := t * 0x76F50F34
		swapAcc += edgeRot16(q)*0xC3EFEA97 + q
		t = edgeRot16(offsets[i+1] + y)
		q = t * 0x1881CE3C
		swapLast = edgeRot16(q)*0x35BD1EC9 + q
		swapAcc += swapLast

		state = state*keyA + x
		state = edgeRot16(state) * 0xCF98B111
		state = edgeRot16(state) * 0x87085B9F
		state = edgeRot16(state) * 0x12CEB96D
		state = edgeRot16(state) * 0x257E1D83
		acc += state

		t = state*keyB + y
		t = edgeRot16(t) * 0xA27416F5
		t = edgeRot16(t) * 0xD38396FF
		state = edgeRot16(edgeRot16(t)*0x7C932B89) * 0xBFA49F69
		acc += state
	}
	return swapLast ^ state, swapAcc ^ acc
}

// edgeTokenV2 is the whole token: "<cs64 16 hex>-<salted sha256 64 hex>".
// `unix` is floored to a five-minute bucket, because the server recomputes the
// value from its own clock and rejects anything from a different window.
func edgeTokenV2(unix int64, token string) string {
	ticks := (unix + 11644473600) * 10_000_000
	ticks -= ticks % 3_000_000_000
	data := []byte(fmt.Sprintf("%d%s", ticks, token))

	digest, ok := edgeSHA256Digest(data)
	if !ok {
		return ""
	}
	a, b := edgeCS64Digest(data, digest)
	var head [8]byte
	binary.LittleEndian.PutUint32(head[0:4], a)
	binary.LittleEndian.PutUint32(head[4:8], b)
	return strings.ToUpper(hex.EncodeToString(head[:])) + "-" +
		strings.ToUpper(hex.EncodeToString(digest[:]))
}
