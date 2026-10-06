import sys
p=sys.argv[1]; s=open(p).read()
a="""   grapheme's line box — not the line box itself — so outlines aren't stretched."""
b="""   grapheme's line box — not the line box itself — so outlines aren't stretched.
   The vertex shader grows the quad by a device pixel per side (em extends
   past [0,1]) so the AA fringe outside the outline isn't clipped; without
   it, stems at the ink box's edge (l, i) render thin."""
assert s.count(a)==1; s=s.replace(a,b); open(p,'w').write(s)
