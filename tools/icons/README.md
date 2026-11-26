# 3D habit icons

The images in `img/habits/` are rendered from the three.js models in
`models.html` (one function per image, glossy "toy" style).

To add or change one: edit `models.html`, then from this folder

```sh
npm i three@0.170.0
python3 -m http.server 8766 &
mkdir -p out && node render.js out <name>      # or no name for all of them
python3 crop.py out/*.png
python3 -c "from PIL import Image; import glob,os; [Image.open(f).resize((320,320)).save('../../img/habits/'+os.path.basename(f)[:-4]+'.webp',quality=88,method=6) for f in glob.glob('out/*.png')]"
```

and map the habit's name to it in `ICON_GUESSES` (app.js).
