all: ennuizel-better-normalization.js

ennuizel-better-normalization.js: ennuizel-better-normalization.ts node_modules/.bin/tsc
	./node_modules/.bin/tsc -t es5 --lib es2015,dom $<

node_modules/.bin/tsc:
	npm install

clean:
	rm -f ennuizel-better-normalization.js

distclean: clean
	rm -rf node_modules
