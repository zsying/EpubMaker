package epub

import (
	"bytes"
	"encoding/xml"
	"io"
	"strings"
)

// XMLNode is a namespace-stripped element node from a simple XML document. It
// is intentionally minimal — we only need element local names, attributes,
// direct text, and child navigation (OPF / NCX / NAV / WebDAV multistatus).
type XMLNode struct {
	Local    string
	Attrs    map[string]string
	Text     string
	Children []*XMLNode
}

func localName(s string) string {
	if i := strings.IndexByte(s, ':'); i >= 0 {
		return s[i+1:]
	}
	return s
}

// ParseXMLString builds a namespace-stripped tree from an XML string. It is
// exported so other packages (e.g. the WebDAV client) can reuse the same
// tolerant parser.
func ParseXMLString(data string) (*XMLNode, error) {
	return parseXMLTree([]byte(data))
}

// Find returns the first direct child with the given local name.
func (n *XMLNode) Find(local string) *XMLNode {
	if n == nil {
		return nil
	}
	return n.find(local)
}

// FindAll returns every direct child with the given local name.
func (n *XMLNode) FindAll(local string) []*XMLNode {
	if n == nil {
		return nil
	}
	return n.findAll(local)
}

// parseXMLTree builds a namespace-stripped tree from XML bytes. Namespaces are
// dropped from both element names and attribute names. It never fails on minor
// well-formedness issues (Strict is off), which matches how we tolerate real
// world EPUB/DAV payloads.
//
// The returned node is a synthetic #root wrapper whose children hold the
// document element(s). This mirrors fast-xml-parser, where find()/findAll()
// search the whole tree, so callers can do root.Find("package") and
// root.FindAll("rootfile") regardless of nesting depth.
func parseXMLTree(data []byte) (*XMLNode, error) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = false

	root := &XMLNode{Local: "#root", Attrs: map[string]string{}}
	stack := []*XMLNode{root}

	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			n := &XMLNode{Local: localName(t.Name.Local), Attrs: map[string]string{}}
			for _, a := range t.Attr {
				n.Attrs[localName(a.Name.Local)] = a.Value
			}
			top := stack[len(stack)-1]
			top.Children = append(top.Children, n)
			stack = append(stack, n)
		case xml.EndElement:
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		case xml.CharData:
			if len(stack) > 0 {
				stack[len(stack)-1].Text += string(t)
			}
		}
	}
	return root, nil
}

// find returns the first descendant (depth-first) with the given local name.
func (n *XMLNode) find(local string) *XMLNode {
	if n == nil {
		return nil
	}
	for _, c := range n.Children {
		if c.Local == local {
			return c
		}
		if r := c.find(local); r != nil {
			return r
		}
	}
	return nil
}

// findAll returns every descendant (depth-first) with the given local name.
func (n *XMLNode) findAll(local string) []*XMLNode {
	if n == nil {
		return nil
	}
	var out []*XMLNode
	for _, c := range n.Children {
		if c.Local == local {
			out = append(out, c)
		}
		out = append(out, c.findAll(local)...)
	}
	return out
}

// text returns the trimmed direct character data of the node.
func (n *XMLNode) text() string {
	if n == nil {
		return ""
	}
	return strings.TrimSpace(n.Text)
}
