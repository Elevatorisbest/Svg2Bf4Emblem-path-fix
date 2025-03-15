/*
Copyright (C) 2013 Tor Knutsson - http://tewr.github.io
... (License remains the same) ...
*/

var Svg2b4Emblem = {
    convert: function (svgText, log) {
        log = log || function (message) {
            console.log("Svg2b4Emblem:", message);
            displayLog(message);
        };

        var svgDoc;

        try {
            log("Parsing SVG text...");
            svgDoc = (new DOMParser()).parseFromString(svgText, "text/xml");
            if (svgDoc.getElementsByTagName('parsererror').length > 0) {
                log("SVG Parsing Error: " + svgDoc.getElementsByTagName('parsererror')[0].textContent);
                return [];
            }
            log("SVG parsed successfully.");
        } catch (e) {
            log("Unable to load svg: " + e);
            return [];
        }

        var r2d = (180 / Math.PI);

        function asinDeg(quote) { return r2d * Math.asin(quote); }
        function acosDeg(quote) { return r2d * Math.acos(quote); }
        function getAccumulatedSign() {
            var sign = 1;
            for (var i = 0; i < arguments.length; i++) {
                sign *= ((arguments[i] < 0) ? -1 : 1);
            }
            return sign;
        }

        function getTransformationCalls(transformCall) {
            var calls = [];
            var r = /([a-z]*)\(([0-9\-\. ]*)\)/g;
            var matches = r.exec(transformCall);
            while (matches != null) {
                calls.push({
                    "func": matches[1],
                    "args": $.map(matches[2].split(" "), function (item) { return parseFloat(item); })
                });
                matches = r.exec(transformCall);
            };
            return calls;
        }

        var defsElements = {};

        function flattenGroups(ix, item) {
            if (item.tagName === "g") {
                log("Flattening group element.");
                var groupTransforms = $(item).attr("transform") || "";
                return $.makeArray($(item).children().map(function(childIx, child) {
                    var childTransforms = $(child).attr("transform") || "";
                    $(child).attr("transform", groupTransforms + " " + childTransforms);
                    return flattenGroups(childIx, child);
                }));
            } else if (item.tagName === "defs") {
                log("Processing defs element.");
                $(item).children().each(function(defIndex, defItem) {
                    var id = $(defItem).attr('id');
                    if (id) {
                        defsElements[id] = defItem;
                        log("Stored def element: " + defItem.tagName + " with id: " + id);
                    } else {
                        log("WARN: Def element without ID, skipping.");
                    }
                });
                return [];
            } else if (item.tagName === "use") {
                log("Processing use element.");
                var href = $(item).attr('xlink:href') || $(item).attr('href');
                if (href && href.startsWith('#')) {
                    var defId = href.substring(1);
                    var defElement = defsElements[defId];
                    if (defElement) {
                        log("Found referenced def element: " + defElement.tagName + " id: " + defId);
                        var clonedElement = defElement.cloneNode(true);
                        $.each(item.attributes, function() {
                            if(this.name !== 'xlink:href' && this.name !== 'href') {
                                clonedElement.setAttribute(this.name, this.value);
                            }
                        });
                        return [clonedElement];
                    } else {
                        log("WARN: <use> element references undefined def id: " + defId);
                    }
                } else {
                    log("WARN: <use> element without valid xlink:href or href, or not referencing local def.");
                }
                return [];
            }
            return [item];
        }


        function applyTransform(point, transformCalls) {
            let x = point.x;
            let y = point.y;

            for (const call of transformCalls) {
                const args = call.args;
                switch (call.func) {
                    case 'translate':
                        x += args[0] || 0;
                        y += args[1] || 0;
                        break;
                    case 'scale':
                        x *= args[0];
                        y *= (args.length > 1) ? args[1] : args[0];
                        break;
                    case 'rotate':
                        const angleRad = args[0] * Math.PI / 180;
                        const cos = Math.cos(angleRad);
                        const sin = Math.sin(angleRad);
                        const x1 = x * cos - y * sin;
                        const y1 = x * sin + y * cos;
                        x = x1;
                        y = y1;
                        if (args.length === 3){
                            x -= args[1];
                            y -= args[2];
                            const rotatedX = x * Math.cos(angleRad) - y * Math.sin(angleRad);
                            const rotatedY = x * Math.sin(angleRad) + y * Math.cos(angleRad);
                            x = rotatedX + args[1];
                            y = rotatedY + args[2];
                        }
                        break;
                    case 'matrix':
                        if(args.length === 6){
                            const a = args[0];
                            const b = args[1];
                            const c = args[2];
                            const d = args[3];
                            const e = args[4];
                            const f = args[5];
                            const x1 = a * x + c * y + e;
                            const y1 = b * x + d * y + f;
                            x = x1;
                            y = y1;
                        }
                        break;
                    case 'skewX':
                        const angleXRad = args[0] * Math.PI / 180;
                        x += Math.tan(angleXRad) * y;
                        break;
                    case 'skewY':
                        const angleYRad = args[0] * Math.PI /180;
                        y += Math.tan(angleYRad) * x;
                        break;
                    default:
                        log("WARN: Unsupported transformation: " + call.func);
                }
            }
            return { x: x, y: y };
        }


        function parsePath(item) {
            log("Processing path element.");
            const pathData = $(item).attr("d");
            if (!pathData) {
                log("WARN: Skipping path - No path data (d attribute).");
                return;
            }

            let fill = $(item).attr("fill");
            log("Path - Initial fill attribute: " + fill); // LOGGING: Check initial fill
            if (!fill || fill === "none") {
                fill = "#000000";
                log("Path - Fill set to default black."); // LOGGING: Default fill
            }
            let opacity = $(item).attr("opacity") || 1;
            let transform = $(item).attr("transform") || "";
            let transformCalls = getTransformationCalls(transform);

            const commands = pathData.match(/([a-zA-Z])([^a-zA-Z]*)/g);
            if (!commands) {
                log("WARN: Skipping path - Invalid path data (no commands found).");
                return null;
            }

            let points = [];
            let currentX = 0;
            let currentY = 0;
            let subpathStartX = 0;
            let subpathStartY = 0;


            for (const command of commands) {
                const type = command.charAt(0);
                const values = command.substring(1).trim().split(/[\s,]+/).filter(Boolean).map(parseFloat);
                const isRelative = (type === type.toLowerCase());

                switch (type.toUpperCase()) {
                    case 'M':
                        for (let i = 0; i < values.length; i += 2) {
                            let x = values[i];
                            let y = values[i + 1]
                            if(isRelative){ x += currentX; y += currentY;}
                            if (!isNaN(x) && !isNaN(y)) {
                                let transformedPoint = applyTransform({ x: x, y: y }, transformCalls);
                                points.push(transformedPoint);
                                currentX = transformedPoint.x;
                                currentY = transformedPoint.y;
                                subpathStartX = currentX;
                                subpathStartY = currentY;
                            }
                        }
                        break;
                    case 'L':
                        for (let i = 0; i < values.length; i += 2) {
                             let x = values[i];
                             let y = values[i + 1];
                            if(isRelative){ x += currentX; y += currentY;}
                            if (!isNaN(x) && !isNaN(y)) {
                                let transformedPoint = applyTransform({ x: x, y: y }, transformCalls);
                                points.push(transformedPoint);
                                currentX = transformedPoint.x;
                                currentY = transformedPoint.y;
                            }
                        }
                        break;
                    case 'H':
                        for (const val of values){
                            let x = val;
                            if(isRelative){ x += currentX;}
                            let transformedPoint = applyTransform({x: x, y: currentY}, transformCalls);
                            points.push(transformedPoint);
                            currentX = transformedPoint.x;
                        }
                        break;
                    case 'V':
                        for (const val of values){
                            let y = val;
                            if(isRelative){ y += currentY;}
                            let transformedPoint = applyTransform({x: currentX, y: y}, transformCalls);
                            points.push(transformedPoint);
                            currentY = transformedPoint.y;
                        }
                        break;
                    case 'Z':
                        if (points.length > 0) {
                            let transformedPoint = applyTransform({x: subpathStartX, y: subpathStartY}, transformCalls);
                            points.push(transformedPoint);
                            currentX = transformedPoint.x;
                            currentY = transformedPoint.y;
                        }
                        break;
                    case 'C':
                        for (let i = 0; i < values.length; i += 6) {
                            let x1 = values[i];
                            let y1 = values[i+1];
                            let x2 = values[i+2];
                            let y2 = values[i+3];
                            let x = values[i+4];
                            let y = values[i+5];
                            if(isRelative){
                                x1 += currentX; y1 += currentY;
                                x2 += currentX; y2 += currentY;
                                x += currentX; y += currentY;
                            }
                            if(!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2) && !isNaN(x) && !isNaN(y)){
                                const STEPS = 20;
                                for(let j = 0; j <= STEPS; j++){
                                    let t = j / STEPS;
                                    let oneMinusT = 1-t;
                                    let oneMinusT2 = oneMinusT * oneMinusT;
                                    let oneMinusT3 = oneMinusT2 * oneMinusT;
                                    let t2 = t * t;
                                    let t3 = t2 * t;

                                    let lineX = oneMinusT3 * currentX + 3 * oneMinusT2 * t * x1 + 3 * oneMinusT * t2 * x2 + t3 * x;
                                    let lineY = oneMinusT3 * currentY + 3 * oneMinusT2 * t * y1 + 3 * oneMinusT * t2 * y2 + t3 * y;

                                    let transformedPoint = applyTransform({x: lineX, y: lineY}, transformCalls);
                                    points.push(transformedPoint);
                                }
                                let transformedEndPoint = applyTransform({x: x, y: y}, transformCalls);
                                currentX = transformedEndPoint.x;
                                currentY = transformedEndPoint.y;
                            }
                        }
                        break;
                    case 'S':
                      for (let i = 0; i < values.length; i += 4) {
                            let x2 = values[i];
                            let y2 = values[i+1];
                            let x = values[i+2];
                            let y = values[i+3];
                            if(isRelative){
                                x2 += currentX; y2 += currentY;
                                x += currentX; y += currentY;
                            }
                            let prevCommand = commands[commands.indexOf(command)-1];
                            let x1, y1;

                            if(prevCommand && prevCommand.toUpperCase() === 'C' || prevCommand && prevCommand.toUpperCase() === 'S' ){
                                let pValues = prevCommand.substring(1).trim().split(/[\s,]+/).filter(Boolean).map(parseFloat);
                                let pX2 = pValues[pValues.length - 4];
                                let pY2 = pValues[pValues.length - 3];
                                 if (prevCommand.charAt(0) === prevCommand.charAt(0).toLowerCase()){
                                  pX2 += currentX;
                                  pY2 += currentY;
                                }
                                x1 = currentX + (currentX - pX2);
                                y1 = currentY + (currentY - pY2);
                            } else {
                                x1 = currentX;
                                y1 = currentY;
                            }

                            if(!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2) && !isNaN(x) && !isNaN(y)){
                                const STEPS = 20;
                                for(let j = 0; j <= STEPS; j++){
                                    let t = j / STEPS;
                                    let oneMinusT = 1-t;
                                    let oneMinusT2 = oneMinusT * oneMinusT;
                                    let oneMinusT3 = oneMinusT2 * oneMinusT;
                                    let t2 = t * t;
                                    let t3 = t2 * t;

                                    let lineX = oneMinusT3 * currentX + 3 * oneMinusT2 * t * x1 + 3 * oneMinusT * t2 * x2 + t3 * x;
                                    let lineY = oneMinusT3 * currentY + 3 * oneMinusT2 * t * y1 + 3 * oneMinusT * t2 * y2 + t3 * y;

                                    let transformedPoint = applyTransform({x: lineX, y: lineY}, transformCalls);
                                    points.push(transformedPoint);
                                }
                                let transformedEndPoint = applyTransform({x: x, y: y}, transformCalls);
                                currentX = transformedEndPoint.x;
                                currentY = transformedEndPoint.y;
                            }
                      }
                      break;
                    case 'Q':
                        for(let i = 0; i < values.length; i += 4) {
                            let x1 = values[i];
                            let y1 = values[i + 1];
                            let x = values[i + 2];
                            let y = values[i + 3];

                            if(isRelative){
                                x1 += currentX; y1 += currentY;
                                x += currentX; y += currentY;
                            }
                            if(!isNaN(x1) && !isNaN(y1) && !isNaN(x) && !isNaN(y)){
                                const STEPS = 20;
                                for(let j = 0; j <= STEPS; j++){
                                    let t = j/STEPS;
                                    let oneMinusT = 1 - t;
                                    let oneMinusT2 = oneMinusT * oneMinusT;
                                    let t2 = t * t;

                                    let lineX = oneMinusT2 * currentX + 2 * oneMinusT * t * x1 + t2 * x;
                                    let lineY = oneMinusT2 * currentY + 2 * oneMinusT * t * y1 + t2 * y;
                                    let transformedPoint = applyTransform({x: lineX, y: lineY}, transformCalls);
                                    points.push(transformedPoint);
                                }
                                let transformedEndPoint = applyTransform({x:x, y:y}, transformCalls);
                                currentX = transformedEndPoint.x;
                                currentY = transformedEndPoint.y;
                            }
                        }
                        break;
                    case 'T':
                        for (let i = 0; i < values.length; i+=2){
                            let x = values[i];
                            let y = values[i + 1];
                            if(isRelative){ x += currentX; y += currentY;}
                            let prevCommand = commands[commands.indexOf(command) - 1];
                            let x1, y1;
                            if(prevCommand && prevCommand.toUpperCase() === 'Q' || prevCommand && prevCommand.toUpperCase() === 'T'){

                                let pValues = prevCommand.substring(1).trim().split(/[\s,]+/).filter(Boolean).map(parseFloat);
                                let pX1 = pValues[pValues.length - 4];
                                let pY1 = pValues[pValues.length - 3];
                                 if (prevCommand.charAt(0) === prevCommand.charAt(0).toLowerCase()){
                                  pX1 += currentX;
                                  pY1 += currentY;
                                }
                                x1 = currentX + (currentX - pX1);
                                y1 = currentY + (currentY - pY1);
                            } else {
                                x1 = currentX;
                                y1 = currentY;
                            }
                            if(!isNaN(x1) && !isNaN(y1) && !isNaN(x) && !isNaN(y)){
                                const STEPS = 20;
                                for(let j = 0; j <= STEPS; j++){
                                    let t = j/STEPS;
                                    let oneMinusT = 1 - t;
                                    let oneMinusT2 = oneMinusT * oneMinusT;
                                    let t2 = t * t;

                                    let lineX = oneMinusT2 * currentX + 2 * oneMinusT * t * x1 + t2 * x;
                                    let lineY = oneMinusT2 * currentY + 2 * oneMinusT * t * y1 + t2 * y;
                                    let transformedPoint = applyTransform({x: lineX, y: lineY}, transformCalls);
                                    points.push(transformedPoint);
                                }
                                 let transformedEndPoint = applyTransform({x:x, y:y}, transformCalls);
                                currentX = transformedEndPoint.x;
                                currentY = transformedEndPoint.y;
                            }
                        }
                        break;
                    case 'A':
                      for (let i = 0; i < values.length; i += 7) {
                        let rx = values[i];
                        let ry = values[i + 1];
                        let xAxisRotation = values[i + 2];
                        let largeArcFlag = values[i + 3];
                        let sweepFlag = values[i + 4];
                        let x = values[i + 5];
                        let y = values[i + 6];
                        if(isRelative){ x += currentX; y += currentY;}

                        if (!isNaN(rx) && !isNaN(ry) && !isNaN(xAxisRotation) && !isNaN(largeArcFlag) && !isNaN(sweepFlag) && !isNaN(x) && !isNaN(y)) {

                            let xAxisRotationRad = xAxisRotation * Math.PI / 180;
                            let cosPhi = Math.cos(xAxisRotationRad);
                            let sinPhi = Math.sin(xAxisRotationRad);
                            let x1p =  (cosPhi * (currentX - x) / 2) + (sinPhi * (currentY - y) / 2);
                            let y1p = (-sinPhi * (currentX - x) / 2) + (cosPhi * (currentY - y) / 2);

                            rx = Math.abs(rx);
                            ry = Math.abs(ry);

                            let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
                            if(lambda > 1){
                                rx = Math.sqrt(lambda) * rx;
                                ry = Math.sqrt(lambda) * ry;
                            }

                            let rx2 = rx * rx;
                            let ry2 = ry * ry;
                            let x1p2 = x1p * x1p;
                            let y1p2 = y1p * y1p;


                            let sign = (largeArcFlag === sweepFlag) ? -1 : 1;
                            let radicand = ( (rx2 * ry2) - (rx2 * y1p2) - (ry2 * x1p2) ) / ( (rx2 * y1p2) + (ry2 * x1p2) )
                            radicand = Math.max(0, radicand);
                            let coeff = sign * Math.sqrt(radicand);

                            let cxp = coeff *  ( (rx * y1p) / ry);
                            let cyp = coeff * -( (ry * x1p) / rx);

                            let cx = (cosPhi * cxp) + (-sinPhi * cyp) + ((currentX + x) / 2);
                            let cy = (sinPhi * cxp) + ( cosPhi * cyp) + ((currentY + y) / 2);

                            let ux = ( x1p - cxp) / rx;
                            let uy = ( y1p - cyp) / ry;
                            let vx = (-x1p - cxp) / rx;
                            let vy = (-y1p - cyp) / ry;

                            let n = Math.sqrt( (ux * ux) + (uy * uy) );
                            let p = ux;
                            sign = (uy < 0) ? -1 : 1;
                            let angleStart = sign * Math.acos( p / n ) * 180 / Math.PI;

                            n = Math.sqrt( (ux * ux + uy * uy) * (vx * vx + vy * vy) );
                            p = ux * vx + uy * vy;
                            sign = (ux * vy - uy * vx < 0) ? -1.0 : 1.0;
                            let angleExtent = sign * Math.acos(p / n) * 180 / Math.PI;

                            if(!sweepFlag && angleExtent > 0) { angleExtent -= 360;} else if (sweepFlag && angleExtent < 0) { angleExtent += 360;}
                            angleExtent %= 360;
                            angleStart %= 360;

                           const STEPS = 20;
                            for (let j = 0; j <= STEPS; j++) {
                                let angle = angleStart + (angleExtent * j / STEPS);
                                let angleRad = angle * Math.PI / 180;

                                let lineX = cx + rx * Math.cos(angleRad) * cosPhi - ry * Math.sin(angleRad) * sinPhi;
                                let lineY = cy + rx * Math.cos(angleRad) * sinPhi + ry * Math.sin(angleRad) * cosPhi;

                                let transformedPoint = applyTransform({ x: lineX, y: lineY }, transformCalls);
                                points.push(transformedPoint);
                            }
                            let transformedEndPoint = applyTransform({x:x, y:y}, transformCalls);
                            currentX = transformedEndPoint.x;
                            currentY = transformedEndPoint.y;
                        }
                      }
                    break;
                    default:
                        log("WARN: Unsupported path command: " + type);
                }
            }

            if (points.length === 0) {
                log("WARN: Path produced no points.");
                return null;
            }

            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            let firstPoint = points[0];
            let lastPoint = points[points.length - 1];
            let pathAngle = 0;

            if (firstPoint && lastPoint && firstPoint.x !== lastPoint.x) {
                 pathAngle = -r2d * Math.atan2(lastPoint.y - firstPoint.y, lastPoint.x - firstPoint.x);
            }


            for (const point of points) {
                minX = Math.min(minX, point.x);
                minY = Math.min(minY, point.y);
                maxX = Math.max(maxX, point.x);
                maxY = Math.max(maxY, point.y);
            }

            const originalWidth = maxX - minX;
            const originalHeight = maxY - minY;
            const originalCenterX = (minX + maxX) / 2;
            const originalCenterY = (minY + maxY) /2;
            let width = originalWidth;
            let height = originalHeight;


            const aspectRatio = originalWidth / originalHeight;
            let assetType = "Square";

            if (Math.abs(aspectRatio - 1) < 0.15) {
                assetType = "Circle";
            }

            // Aspect Ratio Preservation Resize (basic)
            const maxBF4Dimension = 256; // Example max dimension for BF4 assets - adjust if needed
            if (width > maxBF4Dimension || height > maxBF4Dimension) {
                if (width > height) {
                    width = maxBF4Dimension;
                    height = maxBF4Dimension / aspectRatio; // Scale height to preserve aspect
                } else {
                    height = maxBF4Dimension;
                    width = maxBF4Dimension * aspectRatio; // Scale width to preserve aspect
                }
                log(`Path - Resized to width: ${width.toFixed(2)}, height: ${height.toFixed(2)} to fit max dimension.`); // LOGGING resize
            }


            return {
                "asset": assetType,
                "left": originalCenterX, // Keep original center for left/top
                "top": originalCenterY,
                "fill": fill,
                "width": width,
                "height": height,
                "angle": pathAngle,
                "opacity": opacity,
                "selectable": true
            };
        }


        function treatItem(item) {
            log("Processing item: " + item.tagName);
            var fill = $(item).attr("fill");
            log(item.tagName + " - Initial fill attribute: " + fill); // LOGGING: Check initial fill
            if (!fill || fill == "none") {
                 fill = "#000000";
                log(item.tagName + " - Fill set to default black."); // LOGGING: Default fill
            }
            var opacity = $(item).attr("opacity") || 1;

            if (item.tagName == "line") {
                log("Processing line element.");
                fill = $(item).attr("stroke");
                log("Line - Stroke attribute: " + fill); // LOGGING: Line stroke
                if (!fill || fill == "none") {
                     fill = "#000000";
                    log("Line - Stroke set to default black."); // LOGGING: Default stroke
                }


                var x1 = parseFloat($(item).attr("x1"));
                var y1 = parseFloat($(item).attr("y1"));
                var x2 = parseFloat($(item).attr("x2"));
                var y2 = parseFloat($(item).attr("y2"));
                var strokeWidth = parseFloat($(item).attr("stroke-width") || 1);

                if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
                    log("WARN: Skipping line - Invalid coordinates.");
                    return;
                }

                var heightDiff = y2 - y1;
                var height = Math.abs(heightDiff);
                var oppositeDiff = x2 - x1;
                var oppositeLength = Math.abs(oppositeDiff);
                var sign = oppositeDiff < 0 ? 1 : -1;
                var angle;
                if (x1 == x2) {
                    angle = (y1 < y2) ? 90 : -90;
                } else {
                    height = Math.sqrt(Math.pow(oppositeLength, 2) + Math.pow(height, 2));
                    angle = asinDeg(oppositeLength / height) * sign;
                }

                var left = x1 + (oppositeDiff / 2);
                var top = y1 + (heightDiff / 2);

                return {
                    "asset": "Stroke",
                    "left": left,
                    "top": top,
                    "fill": fill,
                    "width": strokeWidth,
                    "height": height,
                    "angle": angle,
                    "opacity": opacity,
                    "selectable": true
                };
            }

            if (item.tagName == "rect") {
                log("Processing rectangle element.");

                var left = parseFloat($(item).attr("x"));
                var top = parseFloat($(item).attr("y"));
                var width = parseFloat($(item).attr("width"));
                var height = parseFloat($(item).attr("height"));

                if (isNaN(left) || isNaN(top) || isNaN(width) || isNaN(height)) {
                    log("WARN: Skipping rectangle - Invalid dimensions or position.");
                    return;
                }

                var transform = $(item).attr("transform");
                var angle = 0;
                if (transform) {
                    var calls = getTransformationCalls(transform);
                    for (var i = 0; i < calls.length; i++) {
                        var call = calls[i];
                        if (call.func == "matrix") {
                            angle = -getAccumulatedSign(call.args[0], call.args[3]) * acosDeg(Math.abs(call.args[0]));
                        } else if (call.func === "rotate") {
                            angle = -call.args[0];
                        }
                         else {
                            log("WARN: Unsupported transformation for rect: " + call.func);
                        }
                    }
                }

                left = left + (width / 2);
                top = top + (height / 2);

                return {
                    "asset": "Square",
                    "left": left,
                    "top": top,
                    "fill": fill,
                    "width": width,
                    "height": height,
                    "angle": angle,
                    "opacity": opacity,
                    "selectable": true
                }
            }

            if (item.tagName == "ellipse") {
                log("Processing ellipse element.");
                var left = parseFloat($(item).attr("cx"));
                var top = parseFloat($(item).attr("cy"));
                var width = parseFloat($(item).attr("ry")) * 2;
                var height = parseFloat($(item).attr("rx")) * 2;

                 if (isNaN(left) || isNaN(top) || isNaN(width) || isNaN(height)) {
                    log("WARN: Skipping ellipse - Invalid dimensions or position.");
                    return;
                }
                var transform = $(item).attr("transform");
                var angle = 0;
                if (transform) {
                    var calls = getTransformationCalls(transform);
                    for (var i = 0; i < calls.length; i++) {
                        var call = calls[i];
                        if (call.func == "matrix") {
                            angle = -getAccumulatedSign(call.args[0], call.args[3]) * acosDeg(Math.abs(call.args[0]));
                        } else if (call.func === "rotate") {
                             angle = -call.args[0];
                        }
                        else {
                            log("WARN: Unsupported transformation for ellipse: " + call.func);
                        }
                    }
                }

                return {
                    "asset": "Circle",
                    "left": left,
                    "top": top,
                    "width": width,
                    "height": height,
                    "fill": fill,
                    "angle": angle,
                    "opacity": opacity,
                    "selectable": true
                };
            }
             if (item.tagName == "polygon") {
                log("Processing polygon element as Triangle.");
                var pointsAttr = $(item).attr("points");
                if (!pointsAttr) {
                    log("WARN: Skipping polygon - No points attribute.");
                    return;
                }
                var pointPairs = pointsAttr.trim().split(/[\s,]+/);
                if (pointPairs.length < 6) {
                    log("WARN: Skipping polygon - Not enough points for a triangle.");
                    return;
                }

                var polyPoints = [];
                for (let i = 0; i < pointPairs.length; i += 2) {
                    let x = parseFloat(pointPairs[i]);
                    let y = parseFloat(pointPairs[i + 1]);
                    if (isNaN(x) || isNaN(y)) {
                        log("WARN: Skipping polygon - Invalid point coordinates.");
                        return;
                    }
                    polyPoints.push({ x: x, y: y });
                }

                let polygonAngle = 0;
                let firstPoint = polyPoints[0];
                let lastPoint = polyPoints[polyPoints.length - 1];
                if (firstPoint && lastPoint && firstPoint.x !== lastPoint.x) {
                    polygonAngle = -r2d * Math.atan2(lastPoint.y - firstPoint.y, lastPoint.x - firstPoint.x);
                }


                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const point of polyPoints) {
                    minX = Math.min(minX, point.x);
                    minY = Math.min(minY, point.y);
                    maxX = Math.max(maxX, point.x);
                    maxY = Math.max(maxY, point.y);
                }

                const originalWidth = maxX - minX;
                const originalHeight = maxY - minY;
                const originalCenterX = (minX + maxX) / 2;
                const originalCenterY = (minY + maxY) / 2;
                let width = originalWidth;
                let height = originalHeight;

                const maxBF4Dimension = 256; // Example max dimension for BF4 assets
                if (width > maxBF4Dimension || height > maxBF4Dimension) {
                    if (width > height) {
                        width = maxBF4Dimension;
                        height = maxBF4Dimension / (originalWidth / originalHeight);
                    } else {
                        height = maxBF4Dimension;
                        width = maxBF4Dimension * (originalWidth / originalHeight);
                    }
                     log(`Polygon - Resized to width: ${width.toFixed(2)}, height: ${height.toFixed(2)} to fit max dimension.`); // LOGGING resize
                }


                return {
                    "asset": "Triangle",
                    "left": originalCenterX, // Keep original center
                    "top": originalCenterY,
                    "fill": fill,
                    "width": width,
                    "height": height,
                    "angle": polygonAngle,
                    "opacity": opacity,
                    "selectable": true
                };
            }


            log("WARN: Skipped unsupported object " + item.tagName);
        }

        var results = [];
        try {
            $("svg", svgDoc).children().map(flattenGroups).each(function (ix, item) {
                var result = null;

                if (item.tagName === "path") {
                    result = parsePath(item);
                } else if (item.tagName === "line") {
                    result = treatItem(item);
                } else if (item.tagName === "rect") {
                    result = treatItem(item);
                } else if (item.tagName === "ellipse") {
                    result = treatItem(item);
                } else if (item.tagName === "polygon") {
                    result = treatItem(item);
                }
                else {
                    log("WARN: Skipped unsupported object " + item.tagName);
                }


                if (result) {
                    results.push(result);
                    log("Processed item: " + JSON.stringify(result));
                } else if (result === null) {
                    log("Failed to process item: " + item.tagName);
                }
            });
        } catch (e) {
            log("Error during element processing: " + e);
            return [];
        }


        if (results.length > 40) {
            log("WARN: Too many objects - some objects will not be visible. Max is 40, found " + results.length);
        }

        log("Conversion complete. Total items processed: " + results.length);
        return results;
    }
};


function displayLog(message) {
    var logDiv = document.getElementById('logOutput');
    if (!logDiv) {
        logDiv = document.createElement('div');
        logDiv.id = 'logOutput';
        logDiv.style.marginTop = '20px';
        logDiv.style.border = '1px solid #ccc';
        logDiv.style.padding = '10px';
        document.body.appendChild(logDiv);
    }

    var logEntry = document.createElement('p');
    logEntry.textContent = message;
    logDiv.appendChild(logEntry);
}