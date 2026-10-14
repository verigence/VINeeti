"""Deterministic parser for Mahindra dealer stock 'Model Description' strings.

No generative inference. Every rule is explicit, and OEM identifiers are preserved.
Some human-readable paint descriptions are provisional; OEM colour codes remain authoritative.

Reviewed against "stock report as on 05.10.2026" (742 VINs, 258 descriptions) and "Booking-Sept26"
(636 bookings, 247 descriptions). Changes from the original, each marked FIX below:
  FIX 1  Trim lost its "(O)" suffix: "B6 (O)" was read as "B6", "REVX M(O)" as "REVX M" and
         "REVX EDGE (O)" as "REVX EDGE" (16 VINs in the stock report). A word boundary never matches
         after ")", so the pattern fell back to the shorter trim.
  FIX 2  "XUV700" added to the model prefixes: the booking sheet carries it, the list did not.
  FIX 3  parse_description() also returns the paint alias it removed (paint_alias) and the description
         text without the two bracketed codes (text). The booking sheet's Model Description is that same
         text, so parse_text() reads a booking with the same rules.
  FIX 4  Optional dms_colour / dms_seating arguments: the stock report's own Color and Seating columns
         are used when given, instead of the provisional colour dictionary and the catalogue seat default.
"""
import re
from collections import Counter

PATTERN = re.compile(r'^\s*(.*?)\s*\(([AC]\d[A-Z0-9]+)\)\s*\((M\d+)\)\s*$')

# OEM-colour-code dictionary, deliberately independent of the raw short colour alias.
# Values marked REVIEW are a cautious readable label, not manufacturer-certified paint descriptions.
COLOURS = {
 'A0DMNDWHIT':('Diamond White','CODE'), 'A0JAVABRWN':('Java Brown','CODE'),
 'A0RCKYBIEG':('Rocky Beige','REVIEW'), 'A0STELBLK':('Stealth Black','CODE'),
 'A2WHITE':('White','CODE'), 'A3BNTSNMBK':('Burnt Sienna [MBK option]','REVIEW'),
 'A3BTLGRMBK':('Battleship Grey [MBK option]','REVIEW'),
 'A3BTLSGREY':('Battleship Grey','CODE'), 'A3CITRNYLW':('Citrine Yellow','CODE'),
 'A3DARKGREY':('Dark Grey','CODE'), 'A3DEEPFRST':('Deep Forest','CODE'),
 'A3DMNDWHIT':('Diamond White','CODE'),
 'A3DUNBGOBK':('Dune Beige [dual-tone code]','REVIEW'),
 'A3EVRSTMBK':('Everest White [MBK option]','REVIEW'),
 'A3EVRSTOBK':('Everest White / Black roof','CODE'),
 'A3EVRSTWHT':('Everest White','CODE'),
 'A3GLXGROBK':('Galaxy Grey / Black roof','CODE'),
 'A3NBULABLU':('Nebula Blue','CODE'),
 'A3NEBLUMBK':('Nebula Blue [MBK option]','REVIEW'),
 'A3OBNBLKGG':('Black [GG option]','REVIEW'),
 'A3PTRLBLGG':('Blue [GG option]','REVIEW'),
 'A3RSREDBLK':('Red / Black roof','REVIEW'),
 'A3RSREDMBK':('Red [MBK option]','REVIEW'),
 'A3STLTHBLK':('Stealth Black','CODE'),
 'A3STLTHMBK':('Stealth Black [MBK option]','REVIEW'),
 'A3TNTRISRD':('Red [TNTRISRD code]','REVIEW'),
 'C1CNCRTGRY':('Concrete Grey','CODE'), 'C1CRMSNRD':('Crimson Red','CODE'),
 'C1DEEPFRST':('Deep Forest','CODE'), 'C1DMNDWHIT':('Diamond White','CODE'),
 'C1DRZLSLVR':('Dazzling Silver','CODE'),
 'C1DSRTMST':('Desert Myst','CODE'),
 'C1EVEWHDT':('Everest White / Dual Tone','CODE'),
 'C1EVRTWHT':('Everest White','CODE'),
 'C1EVRTWHTM':('Everest White [M option]','REVIEW'),
 'C1FRORNG':('Orange [FRORNG code]','REVIEW'),
 'C1GALGREY':('Galaxy Grey','CODE'),
 'C1JEANSBLU':('Jeans Blue','CODE'),
 'C1JNSBSBLK':('Jeans Blue / Stealth Black','CODE'),
 'C1MDNGTBLK':('Midnight Black','CODE'),
 'C1NBULABLU':('Nebula Blue','CODE'),
 'C1NPERLWHT':('Pearl White [NPERLWHT code]','REVIEW'),
 'C1NPOLBLCK':('Napoli Black','CODE'),
 'C1OCNBLUE':('Ocean Blue','CODE'),
 'C1POLRWHT':('Polar White','CODE'),
 'C1PRLWSBLK':('Pearl White / Stealth Black','CODE'),
 'C1REGLBLU':('Regal Blue','CODE'), 'C1RVELVET':('Ruby Velvet','CODE'),
 'C1STELBLK':('Stealth Black','CODE'),
 'C1STLBLKM':('Stealth Black [M option]','REVIEW'),
 'C1WARMBLUE':('Warm Blue','CODE'),
}

PREFIXES = [
 ('MAHINDRA XUV3XO EV', 'XUV 3XO EV'),
 ('MAHINDRA SUPRO PROFITTRUCK', 'SUPRO PROFITTRUCK'),
 ('SUPRO PROFITTRUCK', 'SUPRO PROFITTRUCK'),
 ('MAHINDRA BOLERO NEO+', 'BOLERO NEO+'),
 ('MAHINDRA BOLERO NEO', 'BOLERO NEO'),
 ('MAHINDRA BOLERO', 'BOLERO'),
 ('BOLERO PIK-UP', 'BOLERO PIK-UP'),
 ('BOLERO CAMPER', 'BOLERO CAMPER'),
 ('BOL MAXX PUP CITY', 'BOL MAXX PUP CITY'),
 ('BOL MAXX PUP HD', 'BOL MAXX PUP HD'),
 ('SCORPIO CLASSIC', 'SCORPIO CLASSIC'),
 ('SCORPIO-N', 'SCORPIO-N'),
 ('THAR ROXX', 'THAR ROXX'),
 ('THAR', 'THAR'),
 ('XUV3XO', 'XUV 3XO'),
 ('XUV7XO', 'XUV 7XO'),
 ('XUV700', 'XUV700'),  # FIX 2: present in the booking sheet; no paint-alias list is known for it
 ('XEV 9S', 'XEV 9S'),
 ('XEV 9E', 'XEV 9E'),
 ('BE 6', 'BE 6'),
 ('VEERO', 'VEERO'),
]
PREFIXES.sort(key=lambda x:len(x[0]), reverse=True)

# Factory paint aliases, only for families whose source format stores them after the vehicle config.
PAINT_ALIASES = {
 'XUV 3XO': ['WQ','XJ','CK','JD','QK','RP','RQ','AE','ZX','ZW','AD','AC','ZV'],
 'XUV 3XO EV': ['WQ','XJ','CK','JD','QK','RP','RQ','AE','ZX','ZW','AD','AC','ZV'],
 'SCORPIO-N': ['WQ','XJ','JD','BF'],
 'THAR': ['WQ','XJ','JD','QL'],
 'XUV 7XO': ['EWHT DT','EWHT','SBLK','MBLK','RVET','DMST','NBLU','GGRY'],
 'BE 6': ['WQ','RV','QJ','OG','XJ'],
 'XEV 9E': ['XM','WS','WQ','QJ'],
 'XEV 9S': ['WQ','QJ','BN','BZ','RV','XJ'],
 'BOLERO NEO': ['PW+SB','JB+SB','DW','JB','PW','SB'],
 'BOLERO NEO+': ['WHITE','BLACK','SILVER','WHT'],
 'SUPRO PROFITTRUCK': ['WD','BU','RY','BZ'],
}
ROXX_PAINT_RE = re.compile(r'\s+(?:EWT/BR|STL BLK/BR|STL BLK MOCHA|STL BLK|TGO RED/BR|BRT SNA/BR|BTL GRY/BR|NBA BLE/BR)$')

# Catalogue-backed default 5-seater values; no default for commercial vehicles.
MODEL_SEATS = {'XUV 3XO':5, 'XUV 3XO EV':5, 'THAR ROXX':5, 'BE 6':5, 'XEV 9E':5}

# FIX 1: (?![A-Z0-9]) replaces \b where a trim can end in ")": \b never matches between ")" and a space.
TRIM_RE = {
 'XUV 3XO': re.compile(r'^(REVX (?:M\(O\)|EDGE(?: \(O\))?|M|A)|(?:AX\dL?|MX\d)(?: PRO)?)(?![A-Z0-9])'),
 'XUV 3XO EV': re.compile(r'^(AX\dL?)\b'),
 'THAR': re.compile(r'^(LXT|ZXT)\b'),
 'THAR ROXX': re.compile(r'^(STAR EDN|AX\dL?|MX\d)\b'),
 'XUV 7XO': re.compile(r'^(AX\d+[TL]?|AX)\b'),
 'SCORPIO CLASSIC': re.compile(r'^(S11|S)\b'),
 'BE 6': re.compile(r'^(TWO|THREE|FOUR)\b'),
 'XEV 9E': re.compile(r'^(THREE CL|TWO|THREE|FOUR)\b'),
 'XEV 9S': re.compile(r'^(ONE ABOVE|TWO ABOVE|THREE ABOVE|THREE|TWO|ONE)\b'),
 'BOLERO': re.compile(r'^(B\d+(?: \(O\))?)(?![A-Z0-9])'),
 'BOLERO NEO': re.compile(r'^(N\d+(?: \(R\))?)'),
 'BOLERO NEO+': re.compile(r'^(P\d+(?: AMBU)?)\b'),
}

def _trim(family, variant):
    if family == 'SCORPIO-N':
        m=re.search(r'\bZ\d+[A-Z]?(?: S)?\b', variant)
        return m.group(0) if m else ''
    if family.startswith('BOL MAXX PUP'):
        m=re.search(r'\b(SXID|VXID|LXD|VXI|SXI|LX|MX)\b',variant)
        return m.group(1) if m else ''
    if family == 'BOLERO PIK-UP':
        m=re.search(r'\bFB (?:MSD|PSD|PS)\b',variant)
        return m.group(0) if m else ''
    if family == 'BOLERO CAMPER':
        m=re.search(r'\b(?:GOLD ZXD|PSD)\b',variant)
        return m.group(0) if m else ''
    if family == 'SUPRO PROFITTRUCK':
        m=re.search(r'\b(EXCEL|MINI VX)\b',variant)
        return m.group(0) if m else ''
    if family == 'VEERO':
        m=re.search(r'\bV\d\b',variant)
        return m.group(0) if m else ''
    m=TRIM_RE.get(family)
    if m:
        match=m.search(variant)
        return match.group(1) if match else ''
    return ''

FIELDS=('model','trim','transmission','fuel','drive','seater','variant','colour','oem_colour_code','oem_model_code','colour_status','seat_source','parse_status','review_reason','raw_description','paint_alias','text')

def parse_text(core, d=None):
    """Parse the description text without the bracketed codes (also the booking sheet's Model Description)."""
    if d is None:
        d={k:'' for k in FIELDS}
        d['raw_description']=str(core).strip()
    core=re.sub(r'\s+',' ',str(core)).strip()
    d['text']=core
    for prefix, family in PREFIXES:
        if core==prefix or core.startswith(prefix+' '):
            d['model']=family
            variant=core[len(prefix):].strip()
            break
    else:
        d['parse_status']='REVIEW';d['review_reason']='Unknown model prefix';return d
    aliases=PAINT_ALIASES.get(d['model'], [])
    if d['model']=='THAR ROXX':
        m=ROXX_PAINT_RE.search(' '+variant)
        if m:
            d['paint_alias']=m.group(0).strip()   # FIX 3
        variant=ROXX_PAINT_RE.sub('', ' '+variant).strip()
    else:
        for alias in sorted(aliases,key=len,reverse=True):
            if variant.endswith(' '+alias):
                d['paint_alias']=alias             # FIX 3
                variant=variant[:-(len(alias)+1)].strip();break
    # Preserve a complete cleaned OEM variant name; normalize only confirmed token spacing.
    variant=re.sub(r'\bDMT\b','D MT',variant)
    variant=re.sub(r'\s+',' ',variant).strip()
    d['variant']=variant
    d['trim']=_trim(d['model'],variant)
    words=variant.split()
    if 'MT' in words:
        d['transmission']='Manual'
    elif 'AT' in words:
        d['transmission']='Automatic'
    elif 'AS' in words:
        d['transmission']='AutoSHIFT+ (AMT)'
    elif d['model'] in ('BE 6','XEV 9E','XEV 9S','XUV 3XO EV'):
        d['transmission']='Single-speed EV (catalogue)'
    if d['model'] in ('BE 6','XEV 9E','XEV 9S','XUV 3XO EV'):
        d['fuel']='Electric'
    elif 'CNG' in words:
        d['fuel']='CNG'
    elif any(x in words for x in ('D','DS','DSL','D15')):
        d['fuel']='Diesel'
    elif any(x in words for x in ('P','G','PM','PG','PET')):
        d['fuel']='Petrol'
    for x in ('AWD','4WD','RWD','2WD','FWD'):
        if x in words:
            d['drive']=x;break
    seat_match=re.search(r'\b([4-9])\s*(?:S|STR)\b',variant)
    if seat_match:
        d['seater']=int(seat_match.group(1));d['seat_source']='Description'
    elif d['model'] in MODEL_SEATS:
        d['seater']=MODEL_SEATS[d['model']];d['seat_source']='Model catalogue'
    return d

def parse_description(text, dms_colour=None, dms_seating=None):
    """Return a deterministic dict, with blank values where text/catalogue is not sufficient."""
    d={k:'' for k in FIELDS}
    d['raw_description']=str(text).strip()
    m=PATTERN.match(d['raw_description'])
    if not m:
        d['parse_status']='REVIEW'
        d['review_reason']='Invalid suffix pattern: expected (OEM colour code)(M model code)'
        return d
    raw=m.group(1).strip();d['oem_colour_code']=m.group(2);d['oem_model_code']=m.group(3)
    parse_text(raw, d)
    if d['parse_status']=='REVIEW':
        return d
    # FIX 4: the stock report's own Seating column, when given, fills a seat count the description lacks.
    if not d['seater'] or d['seat_source']=='Model catalogue':
        sm=re.match(r'\s*(\d+)',str(dms_seating or ''))
        if sm:
            d['seater']=int(sm.group(1));d['seat_source']='DMS Seating column'
    # Strict code-keyed colour, not the free-text suffix that can be overloaded across families.
    dms=re.sub(r'\s+',' ',str(dms_colour or '')).strip()
    if dms:
        d['colour'],d['colour_status']=dms.upper(),'DMS'   # FIX 4: the DMS's own colour name for this code
    elif d['oem_colour_code'] in COLOURS:
        d['colour'],d['colour_status']=COLOURS[d['oem_colour_code']]
    else:
        d['colour']=d['oem_colour_code'];d['colour_status']='REVIEW'
    issues=[]
    if not d['trim']: issues.append('Trim not mapped')
    if not d['fuel']: issues.append('Fuel not encoded')
    if not d['transmission']: issues.append('Transmission not encoded')
    if not d['drive']: issues.append('Drive not encoded')
    if not d['seater']: issues.append('Seating not encoded')
    if d['colour_status']=='REVIEW': issues.append('Colour display name requires OEM confirmation')
    d['review_reason']='; '.join(issues)
    d['parse_status']='COMPLETE' if not issues else ('PARTIAL - CATALOGUE NEEDED' if not d['colour_status']=='REVIEW' else 'PARTIAL - COLOUR REVIEW')
    return d

def load_markdown(path):
    rows=[]
    for line in open(path, encoding='utf-8'):
        if line.startswith('|') and not line.startswith('| Model') and not line.startswith('| ---'):
            val=line.strip().strip('|').strip()
            if val: rows.append(val)
    return rows

if __name__=='__main__':
    import sys
    rows=load_markdown(sys.argv[1]); parsed=[parse_description(row) for row in rows]
    print('records:',len(rows),'unique descriptions:',len(set(rows)))
    print('unknown family:', sum(not r['model'] for r in parsed))
    print('parse status:',Counter(r['parse_status'] for r in parsed))
    print('model families:',Counter(r['model'] for r in parsed))
    print('missing trims:', sorted({r['raw_description'] for r in parsed if not r['trim']}))
